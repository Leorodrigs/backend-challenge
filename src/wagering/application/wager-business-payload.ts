import type { Money } from '../../shared/domain/value-objects/money.js';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind.js';

export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}
