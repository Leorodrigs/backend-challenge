import type { Money } from '../../shared/domain/value-objects/money.js';

export interface WalletReconciliationSnapshot {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export abstract class WalletReconciliationPersistence {
  /** Reads wallet and ledger from one consistent, read-only snapshot. */
  abstract readSnapshot(
    walletId: string,
  ): Promise<WalletReconciliationSnapshot | undefined>;
}
