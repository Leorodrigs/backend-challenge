import type { MoneyProps } from '../shared/domain/value-objects/money.js';

export interface WalletView {
  id: string; playerId: string; currency: string; balance: MoneyProps;
  version: number; createdAt: string; updatedAt: string;
}
export interface TransactionView {
  id: string; providerId: string; externalTransactionId: string; walletId: string;
  playerId: string; roundId: string; gameId: string; kind: string; money: MoneyProps;
  status: string; referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null; failureCode: string | null;
  createdAt: string; processedAt: string | null;
}
export interface LedgerView {
  id: string; walletId: string; transactionId: string; direction: string;
  money: MoneyProps; balanceBefore: MoneyProps; balanceAfter: MoneyProps; createdAt: string;
}
export interface LedgerPosition { walletId: string; createdAt: string; id: string }
export interface LedgerPage { items: LedgerView[]; nextCursor?: string }

export abstract class FinancialQueryPort {
  abstract wallet(id: string): Promise<WalletView | undefined>;
  abstract transaction(id: string): Promise<TransactionView | undefined>;
  abstract providerTransaction(providerId: string, externalId: string): Promise<TransactionView | undefined>;
  abstract ledger(walletId: string, limit: number, after?: LedgerPosition): Promise<LedgerPage>;
}
