import { randomUUID } from 'node:crypto';

import type { Money } from '../../shared/domain/value-objects/money.js';
import { InsufficientFundsError } from '../../wallet/domain/errors/wallet.errors.js';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import type { WalletBalanceChange } from '../../wallet/domain/wallet.js';
import { FailureCode } from '../domain/failure-code.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../domain/wager-transaction.js';
import { WagerTransactionKind } from '../domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.js';
import {
  UnsupportedWagerTransactionKindError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from './errors/wager-processing.errors.js';
import type { WagerProcessingPersistence } from './wager-processing.persistence.js';

export type ProcessWagerTransactionInput = CreateWagerTransactionProps;

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: Money;
  walletVersion: number;
  failureCode?: FailureCode;
  ledgerEntryId?: string;
}

export class ProcessWagerTransactionUseCase {
  constructor(private readonly persistence: WagerProcessingPersistence) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionResult> {
    if (
      input.kind !== WagerTransactionKind.Bet &&
      input.kind !== WagerTransactionKind.Win &&
      input.kind !== WagerTransactionKind.Loss
    ) {
      throw new UnsupportedWagerTransactionKindError(input.kind);
    }

    const transaction = WagerTransaction.create(input);

    return this.persistence.transactional(async (context) => {
      const { wallets, transactions, ledger } = context;
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

      await transactions.save(transaction);

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
      };
    });
  }
}
