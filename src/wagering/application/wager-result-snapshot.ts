import type { Money } from '../../shared/domain/value-objects/money.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';

export interface WagerResultSnapshot {
  balance: Money;
  walletVersion: number;
}

export interface StoredWagerResult {
  transaction: WagerTransaction;
  snapshot: WagerResultSnapshot | undefined;
}
