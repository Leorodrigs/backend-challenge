import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { Wallet } from '../../wallet/domain/wallet.js';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import type { StoredWagerResult, WagerResultSnapshot } from './wager-result-snapshot.js';

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
    saveFinalStateAndResult(
      transaction: WagerTransaction, snapshot: WagerResultSnapshot,
    ): Promise<void>;
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
