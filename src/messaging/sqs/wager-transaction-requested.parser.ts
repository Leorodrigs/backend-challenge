import { Money } from '../../shared/domain/value-objects/money.js';
import type { WagerBusinessPayload } from '../../wagering/application/wager-business-payload.js';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction-kind.js';
import {
  InvalidWagerTransactionMessageError,
  type WagerMessageField,
} from './errors/wager-message.errors.js';

export const WAGER_TRANSACTION_REQUESTED_TYPE =
  'WagerTransactionRequested' as const;

export interface WagerTransactionRequestedData extends WagerBusinessPayload {
  idempotencyKey: string;
}

export interface WagerTransactionRequestedEnvelope {
  messageId: string;
  type: typeof WAGER_TRANSACTION_REQUESTED_TYPE;
  occurredAt: Date;
  data: WagerTransactionRequestedData;
}

const EXTERNAL_KINDS = new Set<unknown>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
const ISO_8601_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const ENVELOPE_KEYS = ['messageId', 'type', 'occurredAt', 'data'] as const;
const DATA_KEYS = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;
const MONEY_KEYS = ['amount', 'currency'] as const;

export class WagerTransactionRequestedParser {
  parse(body: string | undefined): WagerTransactionRequestedEnvelope {
    if (typeof body !== 'string' || body.length === 0) {
      throw new InvalidWagerTransactionMessageError('body');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(body) as unknown;
    } catch (cause) {
      throw new InvalidWagerTransactionMessageError('json', { cause });
    }

    const envelope = this.requireRecord(decoded, 'json');
    this.assertOnlyKeys(envelope, ENVELOPE_KEYS, 'json');
    const messageId = this.requireIdentifier(envelope.messageId, 'messageId');
    if (envelope.type !== WAGER_TRANSACTION_REQUESTED_TYPE) {
      throw new InvalidWagerTransactionMessageError('type');
    }

    const occurredAt = this.parseOccurredAt(envelope.occurredAt);
    const data = this.requireRecord(envelope.data, 'data');
    this.assertOnlyKeys(data, DATA_KEYS, 'data');
    const kind = data.kind;
    if (!EXTERNAL_KINDS.has(kind)) {
      throw new InvalidWagerTransactionMessageError('kind');
    }

    const typedKind = kind as Exclude<
      WagerTransactionKind,
      WagerTransactionKind.Opening
    >;
    const reference =
      data.referenceExternalTransactionId === undefined
        ? undefined
        : this.requireIdentifier(
            data.referenceExternalTransactionId,
            'referenceExternalTransactionId',
          );
    if (
      (typedKind === WagerTransactionKind.Refund ||
        typedKind === WagerTransactionKind.Rollback) &&
      reference === undefined
    ) {
      throw new InvalidWagerTransactionMessageError(
        'referenceExternalTransactionId',
      );
    }

    const moneyRecord = this.requireRecord(data.money, 'money');
    this.assertOnlyKeys(moneyRecord, MONEY_KEYS, 'money');
    let money: Money;
    try {
      money = Money.from({
        amount: this.requireString(moneyRecord.amount, 'money'),
        currency: this.requireString(moneyRecord.currency, 'money'),
      });
    } catch (cause) {
      if (cause instanceof InvalidWagerTransactionMessageError) throw cause;
      throw new InvalidWagerTransactionMessageError('money', { cause });
    }

    return {
      messageId,
      type: WAGER_TRANSACTION_REQUESTED_TYPE,
      occurredAt,
      data: {
        providerId: this.requireIdentifier(data.providerId, 'providerId'),
        externalTransactionId: this.requireIdentifier(
          data.externalTransactionId,
          'externalTransactionId',
        ),
        idempotencyKey: this.requireIdentifier(
          data.idempotencyKey,
          'idempotencyKey',
        ),
        playerId: this.requireIdentifier(data.playerId, 'playerId'),
        walletId: this.requireIdentifier(data.walletId, 'walletId'),
        roundId: this.requireIdentifier(data.roundId, 'roundId'),
        gameId: this.requireIdentifier(data.gameId, 'gameId'),
        kind: typedKind,
        money,
        ...(reference === undefined
          ? {}
          : { referenceExternalTransactionId: reference }),
      },
    };
  }

  private parseOccurredAt(value: unknown): Date {
    if (typeof value !== 'string') {
      throw new InvalidWagerTransactionMessageError('occurredAt');
    }
    const match = ISO_8601_DATE_TIME.exec(value);
    if (match === null) {
      throw new InvalidWagerTransactionMessageError('occurredAt');
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
    const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
      31,
      leapYear ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][month - 1];
    if (
      daysInMonth === undefined ||
      day < 1 ||
      day > daysInMonth ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      throw new InvalidWagerTransactionMessageError('occurredAt');
    }
    const occurredAt = new Date(value);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InvalidWagerTransactionMessageError('occurredAt');
    }
    return occurredAt;
  }

  private assertOnlyKeys(
    record: Record<string, unknown>,
    allowed: readonly string[],
    field: Extract<WagerMessageField, 'json' | 'data' | 'money'>,
  ): void {
    const allowedKeys = new Set(allowed);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      throw new InvalidWagerTransactionMessageError(field);
    }
  }

  private requireRecord(
    value: unknown,
    field: Extract<WagerMessageField, 'json' | 'data' | 'money'>,
  ): Record<string, unknown> {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new InvalidWagerTransactionMessageError(field);
    }
    return value as Record<string, unknown>;
  }

  private requireIdentifier(
    value: unknown,
    field: Exclude<WagerMessageField, 'body' | 'json' | 'occurredAt' | 'data' | 'kind' | 'money' | 'type'>,
  ): string {
    const identifier = this.requireString(value, field);
    if (identifier.length === 0 || identifier.trim() !== identifier) {
      throw new InvalidWagerTransactionMessageError(field);
    }
    return identifier;
  }

  private requireString(
    value: unknown,
    field: WagerMessageField,
  ): string {
    if (typeof value !== 'string') {
      throw new InvalidWagerTransactionMessageError(field);
    }
    return value;
  }
}
