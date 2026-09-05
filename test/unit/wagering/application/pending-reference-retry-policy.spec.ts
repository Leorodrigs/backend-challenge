import { describe, expect, test } from 'bun:test';
import { PendingReferenceRetryPolicy } from '../../../../src/wagering/application/pending-reference-retry-policy.js';

describe('PendingReferenceRetryPolicy', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  test('exponential backoff caps at maxDelay and preserves the absolute deadline', () => {
    const policy = new PendingReferenceRetryPolicy({ baseDelayMs: 100, maxDelayMs: 350, ttlMs: 10_000 });
    let state = policy.unresolved(undefined, now);
    for (const [index, delay] of [100, 200, 350, 350].entries()) {
      expect(state.attemptCount).toBe(index + 1);
      expect(state.nextAttemptAt).toEqual(new Date(now.getTime() + delay));
      expect(state.deadlineAt).toEqual(new Date(now.getTime() + 10_000));
      state = policy.unresolved(state, now);
    }
  });

  test('nextAttempt is capped to TTL so expiration is eligible without waiting for a longer backoff', () => {
    const policy = new PendingReferenceRetryPolicy({ baseDelayMs: 1_000, ttlMs: 500 });
    const state = policy.unresolved(undefined, now);
    expect(state.nextAttemptAt).toEqual(state.deadlineAt);
    expect(policy.exhausted(state, new Date(now.getTime() + 499))).toBe(false);
    expect(policy.exhausted(state, new Date(now.getTime() + 500))).toBe(true);
  });

  test('maxAttempts includes the initial failed lookup and exhaustion occurs at the boundary', () => {
    const policy = new PendingReferenceRetryPolicy({ maxAttempts: 2 });
    const first = policy.unresolved(undefined, now);
    expect(policy.exhausted(first, now)).toBe(false);
    expect(policy.exhausted(policy.unresolved(first, now), now)).toBe(true);
  });

  test('long retry history never produces an infinite next attempt', () => {
    const policy = new PendingReferenceRetryPolicy();
    const state = policy.unresolved({ attemptCount: 1_100, nextAttemptAt: now, deadlineAt: new Date(now.getTime() + 100_000) }, now);
    expect(state.nextAttemptAt).toEqual(new Date(now.getTime() + 60_000));
  });

  test.each([{ maxAttempts: 0 }, { ttlMs: -1 }, { baseDelayMs: 0.5 }, { maxDelayMs: 1 }, { maxAttempts: Infinity }])('invalid policy %j fails fast', (options) => {
    expect(() => new PendingReferenceRetryPolicy(options)).toThrow(RangeError);
  });
});
