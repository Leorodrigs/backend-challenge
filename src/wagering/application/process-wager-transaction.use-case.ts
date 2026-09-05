import { randomUUID } from 'node:crypto';

import type { Money } from '../../shared/domain/value-objects/money.js';
import { FailureCode } from '../domain/failure-code.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import { WagerTransactionKind } from '../domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  UnsupportedWagerTransactionKindError,
  WagerClaimConflictError,
  WagerResultUnavailableError,
} from './errors/wager-processing.errors.js';
import type { WagerProcessingPersistence } from './wager-processing.persistence.js';
import type { WagerBusinessPayload } from './wager-business-payload.js';
import { ClaimedWagerTransactionProcessor } from './claimed-wager-transaction.processor.js';
import { WagerPayloadHasher } from './wager-payload-hasher.js';

export interface ProcessWagerTransactionInput {
  idempotencyKey: string;
  payload: WagerBusinessPayload;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: Money;
  walletVersion: number;
  failureCode?: FailureCode;
  ledgerEntryId?: string;
  idempotentReplay: boolean;
}

export class ProcessWagerTransactionUseCase {
  private readonly payloadHasher = new WagerPayloadHasher();

  constructor(
    private readonly persistence: WagerProcessingPersistence,
    private readonly processor = new ClaimedWagerTransactionProcessor(),
  ) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionResult> {
    if (
      input.payload.kind !== WagerTransactionKind.Bet &&
      input.payload.kind !== WagerTransactionKind.Win &&
      input.payload.kind !== WagerTransactionKind.Loss &&
      input.payload.kind !== WagerTransactionKind.Refund &&
      input.payload.kind !== WagerTransactionKind.Rollback
    ) {
      throw new UnsupportedWagerTransactionKindError(input.payload.kind);
    }

    const transaction = WagerTransaction.create({
      ...input.payload,
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      payloadHash: this.payloadHasher.hash(input.payload),
      createdAt: new Date(),
    });

    return this.persistence.transactional(async (context) => {
      const { transactions, ledger } = context;
      if (!(await transactions.tryClaim(transaction))) {
        const existing = await transactions.findByIdempotencyKey(
          transaction.idempotencyKey,
        );
        if (existing !== undefined) {
          const original = existing.transaction;
          if (!original.matchesPayload(transaction.payloadHash)) {
            throw new IdempotencyConflictError(transaction.idempotencyKey);
          }
          if (existing.snapshot === undefined) {
            throw new WagerResultUnavailableError(original.id, original.status);
          }
          // A worker may commit after this read. Do not combine a pending snapshot
          // with a ledger that only became visible in a later READ COMMITTED query.
          const originalEntry = original.status === WagerTransactionStatus.Processed
            ? await ledger.findByWalletAndTransactionId(original.walletId, original.id)
            : undefined;
          return {
            transactionId: original.id,
            status: original.status,
            ...existing.snapshot,
            ...(original.failureCode === undefined
              ? {}
              : { failureCode: original.failureCode }),
            ...(originalEntry === undefined
              ? {}
              : { ledgerEntryId: originalEntry.id }),
            idempotentReplay: true,
          };
        }
        const external = await transactions.findByProviderAndExternalTransactionId(
          transaction.providerId, transaction.externalTransactionId,
        );
        if (external !== undefined) {
          throw new ExternalTransactionConflictError(
            transaction.providerId, transaction.externalTransactionId,
          );
        }
        throw new WagerClaimConflictError();
      }
      return this.processor.process(context, transaction);
    });
  }
}
