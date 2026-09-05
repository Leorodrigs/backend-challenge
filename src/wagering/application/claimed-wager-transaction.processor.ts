import { randomUUID } from 'node:crypto';

import { InsufficientFundsError } from '../../wallet/domain/errors/wallet.errors.js';
import { LedgerDirection } from '../../wallet/domain/ledger-direction.js';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import type { WalletBalanceChange } from '../../wallet/domain/wallet.js';
import { FailureCode } from '../domain/failure-code.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import { WagerTransactionKind as Kind } from '../domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../domain/wager-transaction-status.js';
import { WalletNotFoundError, WalletPlayerMismatchError } from './errors/wager-processing.errors.js';
import { PendingReferenceRetryPolicy } from './pending-reference-retry-policy.js';
import type { ProcessWagerTransactionResult } from './process-wager-transaction.use-case.js';
import type { WagerProcessingContext } from './wager-processing.persistence.js';
import type { PendingReferenceWork } from './wager-result-snapshot.js';

// Runs only inside the caller's SQL transaction, after a new claim or a pending row lock.
export class ClaimedWagerTransactionProcessor {
  constructor(private readonly retryPolicy = new PendingReferenceRetryPolicy()) {}

  async process(
    context: WagerProcessingContext,
    transaction: WagerTransaction,
    pending?: PendingReferenceWork,
    now?: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const { wallets, transactions, ledger } = context;
    const wallet = await wallets.findByIdForUpdate(transaction.walletId);
    if (wallet === undefined) throw new WalletNotFoundError(transaction.walletId);
    if (wallet.playerId !== transaction.playerId) throw new WalletPlayerMismatchError(wallet.id);

    // In production read the time after waiting for the financial lock.
    const processedAt = now ?? new Date();
    let retry = pending?.retryState;
    let reference: WagerTransaction | undefined;
    let change: WalletBalanceChange | undefined;

    if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch);
    } else if (retry !== undefined && this.retryPolicy.exhausted(retry, processedAt)) {
      transaction.reject(FailureCode.ReferenceNotFound);
    } else {
      if (transaction.requiresReference()) {
        reference = await transactions.findByProviderAndExternalTransactionId(
          transaction.providerId, transaction.referenceExternalTransactionId!,
        );
        if (reference !== undefined && !this.compatibleReference(transaction, reference)) {
          transaction.reject(FailureCode.InvalidReference);
        } else if (reference === undefined || reference.status !== Status.Processed) {
          transaction.markPendingReference();
          retry = this.retryPolicy.unresolved(retry, processedAt);
          if (this.retryPolicy.exhausted(retry, processedAt)) {
            transaction.reject(FailureCode.ReferenceNotFound);
          }
        } else if (!transaction.money.equals(reference.money)) {
          transaction.reject(FailureCode.ReversalAmountMismatch);
        } else if (await transactions.hasProcessedReversal(reference.id, transaction.kind)) {
          transaction.reject(FailureCode.ReferenceAlreadyReversed);
        }
      }

      // An unresolved pending operation must not move money. A resolved worker item may.
      const canApply = !transaction.isTerminal() &&
        (!transaction.requiresReference() || reference?.status === Status.Processed);
      if (canApply) {
        try {
          if (transaction.affectsBalance()) {
            const direction = transaction.ledgerDirectionFor(reference);
            change = direction === LedgerDirection.Credit
              ? wallet.credit(transaction.money, processedAt)
              : wallet.debit(transaction.money, processedAt);
          }
        } catch (error) {
          if (!(error instanceof InsufficientFundsError)) throw error;
          transaction.reject(transaction.kind === Kind.Rollback
            ? FailureCode.ReversalWouldMakeBalanceNegative : FailureCode.InsufficientFunds);
        }
        if (!transaction.isTerminal()) transaction.markProcessed(reference?.id, processedAt);
      }
    }

    const entry = change === undefined ? undefined : WalletLedgerEntry.create({
      id: randomUUID(), walletId: wallet.id, transactionId: transaction.id,
      direction: transaction.ledgerDirectionFor(reference), money: transaction.money,
      balanceBefore: change.balanceBefore, balanceAfter: change.balanceAfter, createdAt: processedAt,
    });
    const snapshot = transaction.status === Status.PendingReference && pending?.snapshot !== undefined
      ? pending.snapshot : { balance: wallet.balance, walletVersion: wallet.version };
    await transactions.saveStateAndResult(
      transaction, snapshot,
      transaction.status === Status.PendingReference ? retry : this.retryPolicy.clear(retry),
    );
    if (entry !== undefined) {
      await wallets.save(wallet);
      await ledger.append(entry);
    }
    return {
      transactionId: transaction.id, status: transaction.status, ...snapshot,
      ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
      ...(entry === undefined ? {} : { ledgerEntryId: entry.id }),
      idempotentReplay: false,
    };
  }

  private compatibleReference(current: WagerTransaction, reference: WagerTransaction): boolean {
    const allowedKind = current.kind === Kind.Refund ? reference.kind === Kind.Bet
      : [Kind.Bet, Kind.Win, Kind.Refund].includes(reference.kind);
    return allowedKind && reference.id !== current.id &&
      reference.providerId === current.providerId && reference.playerId === current.playerId &&
      reference.walletId === current.walletId && reference.money.currency === current.money.currency &&
      reference.roundId === current.roundId &&
      reference.status !== Status.Rejected && reference.status !== Status.Failed;
  }
}
