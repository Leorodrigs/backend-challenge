import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import { WagerPayloadHasher } from '../../../../src/wagering/application/wager-payload-hasher.js';
import type { WagerBusinessPayload } from '../../../../src/wagering/application/wager-business-payload.js';
import { WagerTransactionKind as Kind } from '../../../../src/wagering/domain/wager-transaction-kind.js';

const payload: WagerBusinessPayload = {
  providerId: 'provider', externalTransactionId: 'external', playerId: 'player', walletId: 'wallet',
  roundId: 'round', gameId: 'ação', kind: Kind.Bet, money: Money.from({ amount: '25.00', currency: 'BRL' }),
};
const hasher = new WagerPayloadHasher();

describe('WagerPayloadHasher', () => {
  test('hashes an independently specified canonical UTF-8 JSON with SHA-256 lowercase hex', () => {
    const canonical = '{"externalTransactionId":"external","gameId":"ação","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player","providerId":"provider","roundId":"round","walletId":"wallet"}';
    expect(hasher.hash(payload)).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
    expect(hasher.hash(payload)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('equal business fields in different insertion order hash identically', () => {
    const reversed = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerBusinessPayload;
    expect(hasher.hash(reversed)).toBe(hasher.hash(payload));
    expect(hasher.hash({ ...payload })).toBe(hasher.hash(payload));
  });

  test.each([
    { money: Money.from({ amount: '25.01', currency: 'BRL' }) },
    { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    { walletId: 'another-wallet' }, { kind: Kind.Win },
    { referenceExternalTransactionId: 'reference' }, { providerId: 'another-provider' },
    { externalTransactionId: 'another-external' }, { playerId: 'another-player' },
    { roundId: 'another-round' }, { gameId: 'another-game' },
  ] satisfies Partial<WagerBusinessPayload>[])('business change changes the hash: %o', (change) => {
    expect(hasher.hash({ ...payload, ...change })).not.toBe(hasher.hash(payload));
  });

  test('different keys, candidate IDs, dates and transport metadata are excluded even at runtime', () => {
    const first = { ...payload, idempotencyKey: 'key-a', id: randomUUID(), createdAt: new Date(0), payloadHash: 'untrusted', correlationId: 'a', headers: { auth: 'a' }, messageId: 'a', receiveCount: 1, traceId: 'a' };
    const second = { ...first, idempotencyKey: 'key-b', id: randomUUID(), createdAt: new Date(), payloadHash: 'different', correlationId: 'b', headers: {}, messageId: 'b', receiveCount: 2, traceId: 'b' };
    expect(first.id).not.toBe(second.id);
    expect(hasher.hash(first)).toBe(hasher.hash(second));
    expect(hasher.hash(first)).toBe(hasher.hash(payload));
    expect(hasher.hash(Object.assign({}, payload, { referenceExternalTransactionId: undefined }))).toBe(hasher.hash(payload));
  });
});
