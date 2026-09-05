import { randomUUID } from 'node:crypto';

import type { Money } from '../../shared/domain/value-objects/money.js';
import { InsufficientFundsError } from '../../wallet/domain/errors/wallet.errors.js';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import type { WalletBalanceChange } from '../../wallet/domain/wallet.js';
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
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from './errors/wager-processing.errors.js';
import type { WagerProcessingPersistence } from './wager-processing.persistence.js';
import type { WagerBusinessPayload } from './wager-business-payload.js';
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

  constructor(private readonly persistence: WagerProcessingPersistence) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionResult> {
    if (
      input.payload.kind !== WagerTransactionKind.Bet &&
      input.payload.kind !== WagerTransactionKind.Win &&
      input.payload.kind !== WagerTransactionKind.Loss
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
      const { wallets, transactions, ledger } = context;
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
          const originalEntry = await ledger.findByWalletAndTransactionId(
            original.walletId, original.id,
          );
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
      const wallet = await wallets.findByIdForUpdate(transaction.walletId);

      if (wallet === undefined) {
        throw new WalletNotFoundError(transaction.walletId);
      }

      if (wallet.playerId !== transaction.playerId) {
        throw new WalletPlayerMismatchError(wallet.id);
      }

      const processedAt = new Date();
      let change: WalletBalanceChange | undefined;

      if (wallet.currency !== transaction.money.currency) {
        transaction.reject(FailureCode.CurrencyMismatch);
      } else {
        try {
          if (transaction.kind === WagerTransactionKind.Bet) {
            change = wallet.debit(transaction.money, processedAt);
          } else if (transaction.kind === WagerTransactionKind.Win) {
            change = wallet.credit(transaction.money, processedAt);
          }
        } catch (error) {
          if (!(error instanceof InsufficientFundsError)) {
            throw error;
          }

          transaction.reject(FailureCode.InsufficientFunds);
        }

        if (transaction.status === WagerTransactionStatus.Pending) {
          transaction.markProcessed(undefined, processedAt);
        }
      }

      // LOSS and zero-value movements have no balance change and no ledger.
      const entry = change === undefined
        ? undefined
        : WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: transaction.ledgerDirectionFor(),
            money: transaction.money,
            balanceBefore: change.balanceBefore,
            balanceAfter: change.balanceAfter,
            createdAt: processedAt,
          });

      const snapshot = { balance: wallet.balance, walletVersion: wallet.version };
      await transactions.saveFinalStateAndResult(transaction, snapshot);

      if (entry !== undefined) {
        await wallets.save(wallet);
        await ledger.append(entry);
      }

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance,
        walletVersion: wallet.version,
        ...(transaction.failureCode === undefined
          ? {}
          : { failureCode: transaction.failureCode }),
        ...(entry === undefined ? {} : { ledgerEntryId: entry.id }),
        idempotentReplay: false,
      };
    });
  }
}
