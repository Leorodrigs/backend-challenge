import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';

import type {
  ApplicationMetrics,
  ProcessingOutcome,
} from '../../observability/application-metrics.js';
import type { Money } from '../../shared/domain/value-objects/money.js';
import { FailureCode } from '../domain/failure-code.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import { WagerTransactionKind } from '../domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.js';
import { ClaimedWagerTransactionProcessor } from './claimed-wager-transaction.processor.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  UnsupportedWagerTransactionKindError,
  WagerClaimConflictError,
  WagerResultUnavailableError,
} from './errors/wager-processing.errors.js';
import type { WagerBusinessPayload } from './wager-business-payload.js';
import { WagerPayloadHasher } from './wager-payload-hasher.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from './wager-processing.persistence.js';

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
    private readonly metrics?: ApplicationMetrics,
    private readonly logger: Pick<Logger, 'log'> = new Logger(
      ProcessWagerTransactionUseCase.name,
    ),
  ) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionResult> {
    const startedAt = performance.now();
    try {
      const result = await this.persistence.transactional((context) =>
        this.executeInContext(context, input),
      );
      const outcome = this.metricOutcome(result);
      if (result.idempotentReplay) {
        this.metrics?.recordDuplicate('business');
      }
      this.metrics?.recordProcessingDuration(
        'direct',
        outcome,
        (performance.now() - startedAt) / 1_000,
      );
      try {
        this.logger.log({
          correlationId: result.transactionId,
          transactionId: result.transactionId,
          walletId: input.payload.walletId,
          providerId: input.payload.providerId,
          kind: input.payload.kind,
          status: result.status,
          failureCode: result.failureCode,
          idempotentReplay: result.idempotentReplay,
          outcome,
        });
      } catch {
        // A logger failure after commit must not turn a confirmed result into failure.
      }
      return result;
    } catch (error: unknown) {
      this.metrics?.recordProcessingDuration(
        'direct',
        'error',
        (performance.now() - startedAt) / 1_000,
      );
      throw error;
    }
  }

  async executeInContext(
    context: WagerProcessingContext,
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
        const originalEntry =
          original.status === WagerTransactionStatus.Processed
            ? await ledger.findByWalletAndTransactionId(
                original.walletId,
                original.id,
              )
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
      const external =
        await transactions.findByProviderAndExternalTransactionId(
          transaction.providerId,
          transaction.externalTransactionId,
        );
      if (external !== undefined) {
        throw new ExternalTransactionConflictError(
          transaction.providerId,
          transaction.externalTransactionId,
        );
      }
      throw new WagerClaimConflictError();
    }
    return this.processor.process(context, transaction);
  }

  private metricOutcome(
    result: ProcessWagerTransactionResult,
  ): ProcessingOutcome {
    if (result.idempotentReplay) return 'replay';
    if (result.status === WagerTransactionStatus.Processed) return 'processed';
    if (result.status === WagerTransactionStatus.Rejected) return 'rejected';
    if (result.status === WagerTransactionStatus.PendingReference) {
      return 'pending_reference';
    }
    return 'error';
  }
}
