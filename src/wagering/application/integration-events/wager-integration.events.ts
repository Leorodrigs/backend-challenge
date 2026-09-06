import { randomUUID } from 'node:crypto';

import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../messaging/integration-events/integration-event.js';
import type { MoneyProps } from '../../../shared/domain/value-objects/money.js';
import type { LedgerDirection } from '../../../wallet/domain/ledger-direction.js';
import type { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry.js';
import type { Wallet } from '../../../wallet/domain/wallet.js';
import type { FailureCode } from '../../domain/failure-code.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { WagerTransactionKind } from '../../domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status.js';

export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId?: string;
  occurredAt?: Date;
}

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override get eventType(): 'WagerTransactionProcessed' {
    return 'WagerTransactionProcessed';
  }

  override get version(): 1 {
    return 1;
  }

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed ||
        transaction.processedAt === undefined) {
      throw new Error('WagerTransactionProcessed requires a processed transaction');
    }
    return new WagerTransactionProcessed({
      ...eventIdentity(transaction.id, context, transaction.processedAt),
      data: {
        ...wagerData(transaction),
        ...(transaction.referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
        ...(transaction.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: transaction.referenceTransactionId }),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override get eventType(): 'WagerTransactionRejected' {
    return 'WagerTransactionRejected';
  }

  override get version(): 1 {
    return 1;
  }

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext & { occurredAt: Date },
  ): WagerTransactionRejected {
    if (transaction.status !== WagerTransactionStatus.Rejected ||
        transaction.failureCode === undefined) {
      throw new Error('WagerTransactionRejected requires a rejected transaction');
    }
    return new WagerTransactionRejected({
      ...eventIdentity(transaction.id, context, context.occurredAt),
      data: {
        ...wagerData(transaction),
        failureCode: transaction.failureCode,
        ...(transaction.referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override get eventType(): 'WagerTransactionPendingReference' {
    return 'WagerTransactionPendingReference';
  }

  override get version(): 1 {
    return 1;
  }

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext & { occurredAt: Date },
  ): WagerTransactionPendingReference {
    if (transaction.status !== WagerTransactionStatus.PendingReference ||
        transaction.referenceExternalTransactionId === undefined) {
      throw new Error('WagerTransactionPendingReference requires a pending reference');
    }
    return new WagerTransactionPendingReference({
      ...eventIdentity(transaction.id, context, context.occurredAt),
      data: {
        ...wagerData(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override get eventType(): 'WalletBalanceChanged' {
    return 'WalletBalanceChanged';
  }

  override get version(): 1 {
    return 1;
  }

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (wallet.id !== entry.walletId || wallet.version < 1 ||
        !wallet.balance.equals(entry.balanceAfter)) {
      throw new Error('WalletBalanceChanged requires the wallet state produced by its ledger entry');
    }
    return new WalletBalanceChanged({
      ...eventIdentity(wallet.id, {
        ...context,
        causationId: context.causationId ?? entry.transactionId,
      }, context.occurredAt ?? entry.createdAt),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

function eventIdentity(
  aggregateId: string,
  context: EventContext,
  occurredAt: Date,
): Omit<IntegrationEventProps<object>, 'data'> {
  return {
    eventId: context.eventId ?? randomUUID(),
    aggregateId,
    correlationId: context.correlationId,
    ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    occurredAt,
  };
}

function wagerData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}
