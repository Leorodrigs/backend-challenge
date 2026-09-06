import { describe, expect, test } from 'bun:test';

import { InboxEnvelopeHasher } from '../../../../src/messaging/sqs/inbox-envelope.hasher.js';
import { InvalidWagerTransactionMessageError } from '../../../../src/messaging/sqs/errors/wager-message.errors.js';
import { WagerTransactionRequestedParser } from '../../../../src/messaging/sqs/wager-transaction-requested.parser.js';
import { WagerTransactionKind } from '../../../../src/wagering/domain/wager-transaction-kind.js';

function validEnvelope(): Record<string, unknown> {
  return {
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: 'player-123',
      walletId: 'wallet-123',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  };
}

describe('WagerTransactionRequestedParser', () => {
  const parser = new WagerTransactionRequestedParser();

  test('validates the envelope and creates Money without number conversion', () => {
    const parsed = parser.parse(JSON.stringify(validEnvelope()));

    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.occurredAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
    expect(parsed.data.kind).toBe(WagerTransactionKind.Bet);
    expect(parsed.data.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test.each([
    [undefined, 'body'],
    ['{', 'json'],
    [JSON.stringify({ ...validEnvelope(), messageId: ' ' }), 'messageId'],
    [JSON.stringify({ ...validEnvelope(), type: 'Unknown' }), 'type'],
    [JSON.stringify({ ...validEnvelope(), occurredAt: 'not-a-date' }), 'occurredAt'],
    [JSON.stringify({ ...validEnvelope(), occurredAt: '2026-02-30T15:00:00.000Z' }), 'occurredAt'],
    [JSON.stringify({ ...validEnvelope(), data: null }), 'data'],
    [JSON.stringify({ ...validEnvelope(), unknown: true }), 'json'],
    [JSON.stringify({ ...validEnvelope(), data: { ...(validEnvelope().data as object), kind: 'OPENING' } }), 'kind'],
    [JSON.stringify({ ...validEnvelope(), data: { ...(validEnvelope().data as object), money: { amount: 25, currency: 'BRL' } } }), 'money'],
    [JSON.stringify({ ...validEnvelope(), data: { ...(validEnvelope().data as object), kind: 'REFUND' } }), 'referenceExternalTransactionId'],
  ] as const)('rejects invalid field %s', (body, field) => {
    try {
      parser.parse(body);
      throw new Error('Expected parsing to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidWagerTransactionMessageError);
      expect((error as InvalidWagerTransactionMessageError).field).toBe(field);
    }
  });

  test('canonical Inbox hash ignores JSON order/whitespace but includes idempotencyKey', () => {
    const hasher = new InboxEnvelopeHasher();
    const first = parser.parse(JSON.stringify(validEnvelope()));
    const source = validEnvelope();
    const data = source.data as Record<string, unknown>;
    const reordered = parser.parse(JSON.stringify({
      data: {
        money: data.money,
        kind: data.kind,
        gameId: data.gameId,
        roundId: data.roundId,
        walletId: data.walletId,
        playerId: data.playerId,
        idempotencyKey: data.idempotencyKey,
        externalTransactionId: data.externalTransactionId,
        providerId: data.providerId,
      },
      occurredAt: source.occurredAt,
      type: source.type,
      messageId: source.messageId,
    }, null, 2));
    expect(hasher.hash(reordered)).toBe(hasher.hash(first));

    const changed = validEnvelope();
    (changed.data as Record<string, unknown>).idempotencyKey = 'another-key';
    expect(hasher.hash(parser.parse(JSON.stringify(changed)))).not.toBe(
      hasher.hash(first),
    );
  });
});
