import type { IntegrationEvent } from '../../messaging/integration-events/integration-event.js';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.js';
import type { Wallet } from '../../wallet/domain/wallet.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './integration-events/wager-integration.events.js';

export interface WagerIntegrationEventTransition {
  transaction: WagerTransaction;
  wallet: Wallet;
  previousStatus: WagerTransactionStatus;
  decidedAt: Date;
  ledgerEntry?: WalletLedgerEntry;
}

export class WagerIntegrationEventFactory {
  createForTransition({
    transaction,
    wallet,
    previousStatus,
    decidedAt,
    ledgerEntry,
  }: WagerIntegrationEventTransition): IntegrationEvent<object>[] {
    const correlationId = transaction.id;
    const events: IntegrationEvent<object>[] = [];

    if (transaction.status === WagerTransactionStatus.Processed &&
        previousStatus !== WagerTransactionStatus.Processed) {
      events.push(WagerTransactionProcessed.from(transaction, { correlationId }));
    } else if (transaction.status === WagerTransactionStatus.Rejected &&
               previousStatus !== WagerTransactionStatus.Rejected) {
      events.push(WagerTransactionRejected.from(transaction, {
        correlationId,
        occurredAt: decidedAt,
      }));
    } else if (transaction.status === WagerTransactionStatus.PendingReference &&
               previousStatus !== WagerTransactionStatus.PendingReference) {
      events.push(WagerTransactionPendingReference.from(transaction, {
        correlationId,
        occurredAt: decidedAt,
      }));
    }

    if (ledgerEntry !== undefined) {
      events.push(WalletBalanceChanged.from(wallet, ledgerEntry, {
        correlationId,
        causationId: transaction.id,
      }));
    }

    return events;
  }
}
