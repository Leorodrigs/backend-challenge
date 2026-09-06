import { describe, expect, test } from 'bun:test';

import { OutboxMessage } from '../../../../src/messaging/outbox/domain/outbox-message.js';
import { WagerTransactionProcessed } from '../../../../src/wagering/application/integration-events/wager-integration.events.js';
import { WagerPayloadHasher } from '../../../../src/wagering/application/wager-payload-hasher.js';
import { WagerTransaction } from '../../../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind } from '../../../../src/wagering/domain/wager-transaction-kind.js';
import { Money } from '../../../../src/shared/domain/value-objects/money.js';

function event() {
  const occurredAt = new Date('2026-09-06T12:00:00.000Z');
  const payload = {
    providerId: 'provider', externalTransactionId: 'external', walletId: 'wallet',
    playerId: 'player', roundId: 'round', gameId: 'game',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  };
  const transaction = WagerTransaction.create({
    ...payload,
    id: 'transaction',
    idempotencyKey: 'key',
    payloadHash: new WagerPayloadHasher().hash(payload),
    createdAt: occurredAt,
  });
  transaction.markProcessed(undefined, occurredAt);
  return WagerTransactionProcessed.from(transaction, {
    eventId: 'event',
    correlationId: transaction.id,
  });
}

describe('OutboxMessage', () => {
  test('enqueues the serialized event with aligned identity and immediate eligibility', () => {
    const message = OutboxMessage.enqueue(event());
    expect(message.id).toBe('event');
    expect(message.aggregateId).toBe('transaction');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeUndefined();
    expect(message.nextAttemptAt).toEqual(message.occurredAt);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(message.occurredAt)).toBe(true);
    expect(message.payload).toEqual(
      event().toJSON() as unknown as Record<string, unknown>,
    );
    expect(typeof (message.payload.data as { money: { amount: unknown } }).money.amount).toBe('string');
  });

  test('uses failed-attempt semantics and capped exponential retry without sleeping', () => {
    const message = OutboxMessage.enqueue(event());
    const now = new Date('2026-09-06T13:00:00.000Z');
    for (const expectedDelay of [100, 200, 400, 500, 500]) {
      message.scheduleRetry(now, { baseDelayMs: 100, maxDelayMs: 500 });
      expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + expectedDelay);
    }
    expect(message.attempts).toBe(5);
    expect(message.isDue(new Date(now.getTime() + 499))).toBe(false);
    expect(message.isDue(new Date(now.getTime() + 500))).toBe(true);
  });

  test('marks published once, clears scheduling, and defensively copies dates', () => {
    const message = OutboxMessage.enqueue(event());
    const publishedAt = new Date('2026-09-06T13:00:00.000Z');
    message.markPublished(publishedAt);
    publishedAt.setUTCFullYear(2000);
    const exposed = message.publishedAt!;
    exposed.setUTCFullYear(2001);
    expect(message.publishedAt?.toISOString()).toBe('2026-09-06T13:00:00.000Z');
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(new Date())).toThrow('already published');
    expect(() => message.scheduleRetry(new Date())).toThrow('published');
  });

  test.each([
    { attempts: -1 },
    { nextAttemptAt: undefined },
    { publishedAt: new Date('2026-09-06T11:00:00.000Z'), nextAttemptAt: undefined },
  ])('rejects an invalid rehydrated state %j', (override) => {
    const queued = OutboxMessage.enqueue(event());
    expect(() => OutboxMessage.rehydrate({
      id: queued.id,
      aggregateId: queued.aggregateId,
      eventType: queued.eventType,
      payload: queued.payload,
      occurredAt: queued.occurredAt,
      attempts: queued.attempts,
      nextAttemptAt: queued.nextAttemptAt,
      publishedAt: queued.publishedAt,
      ...override,
    })).toThrow();
  });

  test('rejects payload values that JSON would silently omit or coerce', () => {
    const queued = OutboxMessage.enqueue(event());
    for (const invalidValue of [undefined, () => undefined, Number.NaN, new Date()]) {
      expect(() => OutboxMessage.rehydrate({
        id: queued.id,
        aggregateId: queued.aggregateId,
        eventType: queued.eventType,
        payload: { ...queued.payload, invalidValue },
        occurredAt: queued.occurredAt,
        attempts: queued.attempts,
        nextAttemptAt: queued.nextAttemptAt,
        publishedAt: queued.publishedAt,
      })).toThrow();
    }
  });
});
