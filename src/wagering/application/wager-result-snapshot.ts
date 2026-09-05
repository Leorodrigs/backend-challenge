import type { Money } from '../../shared/domain/value-objects/money.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { PendingReferenceRetryState } from './pending-reference-retry-policy.js';

export interface WagerResultSnapshot {
  balance: Money;
  walletVersion: number;
}

export interface StoredWagerResult {
  transaction: WagerTransaction;
  snapshot: WagerResultSnapshot | undefined;
}

export interface PendingReferenceWork extends StoredWagerResult {
  retryState: PendingReferenceRetryState;
}
