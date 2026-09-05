export interface PendingReferenceRetryState {
  attemptCount: number;
  nextAttemptAt: Date | null;
  deadlineAt: Date | null;
}

export interface PendingReferenceRetryOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  ttlMs: number;
}

export const DEFAULT_REFERENCE_RETRY_OPTIONS: Readonly<PendingReferenceRetryOptions> = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 1_440,
  ttlMs: 86_400_000,
});

export class PendingReferenceRetryPolicy {
  readonly options: Readonly<PendingReferenceRetryOptions>;

  constructor(options: Partial<PendingReferenceRetryOptions> = {}) {
    const settings = { ...DEFAULT_REFERENCE_RETRY_OPTIONS, ...options };
    if (Object.values(settings).some((value) => !Number.isSafeInteger(value) || value < 1) ||
        settings.maxDelayMs < settings.baseDelayMs || settings.maxAttempts > 2_147_483_647) {
      throw new RangeError('Reference retry settings must be positive integers, with maxDelay >= baseDelay');
    }
    this.options = Object.freeze(settings);
  }

  exhausted(state: PendingReferenceRetryState, now: Date): boolean {
    return state.attemptCount >= this.options.maxAttempts ||
      (state.deadlineAt !== null && now.getTime() >= state.deadlineAt.getTime());
  }

  unresolved(previous: PendingReferenceRetryState | undefined, now: Date): PendingReferenceRetryState {
    const attemptCount = (previous?.attemptCount ?? 0) + 1;
    const deadlineAt = previous?.deadlineAt ?? new Date(now.getTime() + this.options.ttlMs);
    // Cap the exponent too, so a long retry history cannot overflow the delay.
    const exponent = Math.min(attemptCount - 1, Math.ceil(Math.log2(this.options.maxDelayMs / this.options.baseDelayMs)));
    const delay = Math.min(this.options.baseDelayMs * 2 ** exponent, this.options.maxDelayMs);
    return {
      attemptCount,
      deadlineAt,
      nextAttemptAt: new Date(Math.min(now.getTime() + delay, deadlineAt.getTime())),
    };
  }

  clear(state?: PendingReferenceRetryState): PendingReferenceRetryState {
    return { attemptCount: state?.attemptCount ?? 0, nextAttemptAt: null, deadlineAt: null };
  }
}
