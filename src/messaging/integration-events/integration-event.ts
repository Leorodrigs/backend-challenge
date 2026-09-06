export interface IntegrationEventProps<T extends object> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface SerializedIntegrationEvent<T extends object> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;

  private readonly eventOccurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    IntegrationEvent.assertIdentifier(props.eventId, 'eventId');
    IntegrationEvent.assertIdentifier(props.aggregateId, 'aggregateId');
    IntegrationEvent.assertIdentifier(props.correlationId, 'correlationId');
    if (props.causationId !== undefined) {
      IntegrationEvent.assertIdentifier(props.causationId, 'causationId');
    }
    this.eventOccurredAt = IntegrationEvent.copyDate(props.occurredAt, 'occurredAt');
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.data = IntegrationEvent.cloneAndFreezeObject(props.data) as Readonly<T>;
  }

  get occurredAt(): Date {
    return new Date(this.eventOccurredAt.getTime());
  }

  toJSON(): SerializedIntegrationEvent<T> {
    if (typeof this.eventType !== 'string' || this.eventType.trim() === '') {
      throw new TypeError('Integration event eventType must be a non-empty string');
    }
    if (!Number.isSafeInteger(this.version) || this.version < 1) {
      throw new RangeError('Integration event version must be a positive integer');
    }

    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.eventOccurredAt.toISOString(),
      version: this.version,
      data: IntegrationEvent.cloneAndFreezeObject(this.data) as T,
    };
  }

  private static assertIdentifier(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      throw new TypeError(`Integration event ${field} must be a non-empty trimmed string`);
    }
  }

  private static copyDate(value: unknown, field: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError(`Integration event ${field} must be a valid Date`);
    }
    return new Date(value.getTime());
  }

  private static cloneAndFreezeObject<TValue extends object>(value: TValue): TValue {
    const clone = IntegrationEvent.cloneJson(value, 'data');
    if (clone === null || Array.isArray(clone) || typeof clone !== 'object') {
      throw new TypeError('Integration event data must be a JSON object');
    }
    return clone as TValue;
  }

  private static cloneJson(value: unknown, path: string): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError(`Integration event ${path} contains a non-finite number`);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item, index) =>
        IntegrationEvent.cloneJson(item, `${path}[${index}]`)));
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) {
          throw new TypeError(`Integration event ${path}.${key} must not be undefined`);
        }
        result[key] = IntegrationEvent.cloneJson(item, `${path}.${key}`);
      }
      return Object.freeze(result);
    }
    throw new TypeError(`Integration event ${path} must contain only JSON values`);
  }
}
