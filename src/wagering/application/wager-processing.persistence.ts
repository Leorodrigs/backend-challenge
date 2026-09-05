import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { Wallet } from '../../wallet/domain/wallet.js';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import type { PendingReferenceWork, StoredWagerResult, WagerResultSnapshot } from './wager-result-snapshot.js';
import type { PendingReferenceRetryState } from './pending-reference-retry-policy.js';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind.js';

export interface WagerProcessingContext {
  wallets: {
    findByIdForUpdate(id: string): Promise<Wallet | undefined>;
    save(wallet: Wallet): Promise<void>;
  };
  transactions: {
    tryClaim(transaction: WagerTransaction): Promise<boolean>;
    findByIdempotencyKey(key: string): Promise<StoredWagerResult | undefined>;
    findByProviderAndExternalTransactionId(
      providerId: string, externalId: string,
    ): Promise<WagerTransaction | undefined>;
    saveStateAndResult(
      transaction: WagerTransaction, snapshot: WagerResultSnapshot,
      retryState?: PendingReferenceRetryState,
    ): Promise<void>;
    hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
    claimNextPendingReference(now: Date): Promise<PendingReferenceWork | undefined>;
  };
  ledger: {
    append(entry: WalletLedgerEntry): Promise<void>;
    findByWalletAndTransactionId(
      walletId: string, transactionId: string,
    ): Promise<WalletLedgerEntry | undefined>;
  };
}

export abstract class WagerProcessingPersistence {
  // Resolves only after commit; thrown errors roll back the entire operation.
  abstract transactional<T>(
    work: (context: WagerProcessingContext) => Promise<T>,
  ): Promise<T>;
}
