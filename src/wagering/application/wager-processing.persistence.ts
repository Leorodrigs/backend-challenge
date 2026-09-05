import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { Wallet } from '../../wallet/domain/wallet.js';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';

export interface WagerProcessingContext {
  wallets: {
    findByIdForUpdate(id: string): Promise<Wallet | undefined>;
    save(wallet: Wallet): Promise<void>;
  };
  transactions: {
    save(transaction: WagerTransaction): Promise<void>;
  };
  ledger: {
    append(entry: WalletLedgerEntry): Promise<void>;
  };
}

export abstract class WagerProcessingPersistence {
  // Resolves only after commit; thrown errors roll back the entire operation.
  abstract transactional<T>(
    work: (context: WagerProcessingContext) => Promise<T>,
  ): Promise<T>;
}
