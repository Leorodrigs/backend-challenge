import type { IntegrationEvent } from '../../integration-events/integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

export interface OutboxRetryOptions {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY_OPTIONS: Readonly<OutboxRetryOptions> =
  Object.freeze({ baseDelayMs: 1_000, maxDelayMs: 60_000 });

type JsonValue = string | number | boolean | null | readonly JsonValue[] |
  { readonly [key: string]: JsonValue };

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly messageOccurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    OutboxMessage.assertIdentifier(state.id, 'id');
    OutboxMessage.assertIdentifier(state.aggregateId, 'aggregateId');
    OutboxMessage.assertIdentifier(state.eventType, 'eventType');
    if (!Number.isSafeInteger(state.attempts) || state.attempts < 0) {
      throw new RangeError('Outbox attempts must be a non-negative integer');
    }
    const occurredAt = OutboxMessage.copyDate(state.occurredAt, 'occurredAt');
    const nextAttemptAt = state.nextAttemptAt === undefined
      ? undefined
      : OutboxMessage.copyDate(state.nextAttemptAt, 'nextAttemptAt');
    const publishedAt = state.publishedAt === undefined
      ? undefined
      : OutboxMessage.copyDate(state.publishedAt, 'publishedAt');
    if (publishedAt !== undefined && publishedAt.getTime() < occurredAt.getTime()) {
      throw new RangeError('Outbox publishedAt must not precede occurredAt');
    }
    if ((publishedAt === undefined) !== (nextAttemptAt !== undefined)) {
      throw new Error('Pending Outbox messages require nextAttemptAt; published messages must clear it');
    }
    const payload = OutboxMessage.cloneJsonObject(state.payload);
    if (payload.eventId !== state.id || payload.eventType !== state.eventType ||
        payload.aggregateId !== state.aggregateId) {
      throw new Error('Outbox identity must match the serialized integration event');
    }

    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      payload,
      occurredAt,
      state.attempts,
      nextAttemptAt,
      publishedAt,
    );
  }

  get occurredAt(): Date {
    return new Date(this.messageOccurredAt.getTime());
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt === undefined
      ? undefined
      : new Date(this._nextAttemptAt.getTime());
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt === undefined
      ? undefined
      : new Date(this._publishedAt.getTime());
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    const instant = OutboxMessage.copyDate(now, 'now');
    return this.isPending() && this._nextAttemptAt !== undefined &&
      this._nextAttemptAt.getTime() <= instant.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error('Outbox message is already published');
    }
    const publishedAt = OutboxMessage.copyDate(at, 'publishedAt');
    if (publishedAt.getTime() < this.messageOccurredAt.getTime()) {
      throw new RangeError('Outbox publishedAt must not precede occurredAt');
    }
    this._publishedAt = publishedAt;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(
    now: Date,
    options: Readonly<OutboxRetryOptions> = DEFAULT_OUTBOX_RETRY_OPTIONS,
  ): void {
    if (!this.isPending()) {
      throw new Error('Cannot retry a published Outbox message');
    }
    OutboxMessage.assertRetryOptions(options);
    const retryAt = OutboxMessage.copyDate(now, 'now');
    this._attempts += 1;
    const maximumExponent = Math.min(
      52,
      Math.ceil(Math.log2(options.maxDelayMs / options.baseDelayMs)),
    );
    const exponent = Math.min(this._attempts - 1, maximumExponent);
    const delay = Math.min(
      options.baseDelayMs * 2 ** exponent,
      options.maxDelayMs,
    );
    this._nextAttemptAt = new Date(retryAt.getTime() + delay);
  }

  private static assertRetryOptions(options: Readonly<OutboxRetryOptions>): void {
    if (!Number.isSafeInteger(options.baseDelayMs) || options.baseDelayMs < 1 ||
        !Number.isSafeInteger(options.maxDelayMs) || options.maxDelayMs < 1 ||
        options.baseDelayMs > options.maxDelayMs) {
      throw new RangeError('Outbox retry delays must be positive integers with baseDelayMs <= maxDelayMs');
    }
  }

  private static assertIdentifier(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      throw new TypeError(`Outbox ${field} must be a non-empty trimmed string`);
    }
  }

  private static copyDate(value: unknown, field: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError(`Outbox ${field} must be a valid Date`);
    }
    return new Date(value.getTime());
  }

  private static cloneJsonObject(
    value: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const clone = OutboxMessage.cloneJson(value, 'payload');
    if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
      throw new TypeError('Outbox payload must be a JSON object');
    }
    return clone as Readonly<Record<string, unknown>>;
  }

  private static cloneJson(value: unknown, path: string): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError(`Outbox ${path} contains a non-finite number`);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item, index) =>
        OutboxMessage.cloneJson(item, `${path}[${index}]`)));
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const clone: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) {
          throw new TypeError(`Outbox ${path}.${key} must not be undefined`);
        }
        clone[key] = OutboxMessage.cloneJson(item, `${path}.${key}`);
      }
      return Object.freeze(clone);
    }
    throw new TypeError(`Outbox ${path} must contain only JSON values`);
  }
}
