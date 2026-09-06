import { describe, expect, test } from 'bun:test';

import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../../src/messaging/integration-events/integration-event.js';

class TestEvent extends IntegrationEvent<{ value: string; nested: { count: number } }> {
  override get eventType(): string { return 'TestEvent'; }
  override get version(): number { return 1; }

  constructor(props: IntegrationEventProps<{ value: string; nested: { count: number } }>) {
    super(props);
  }
}

class InvalidVersionEvent extends TestEvent {
  override get version(): number { return 0; }
}

describe('IntegrationEvent', () => {
  const occurredAt = new Date('2026-09-06T12:00:00.000Z');

  test('serializes a stable versioned envelope and defensively copies data and dates', () => {
    const data = { value: 'ok', nested: { count: 1 } };
    const event = new TestEvent({
      eventId: 'event-1',
      aggregateId: 'aggregate-1',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      occurredAt,
      data,
    });
    occurredAt.setUTCFullYear(2000);
    data.nested.count = 2;

    expect(event.occurredAt.toISOString()).toBe('2026-09-06T12:00:00.000Z');
    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'TestEvent',
      aggregateId: 'aggregate-1',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      occurredAt: '2026-09-06T12:00:00.000Z',
      version: 1,
      data: { value: 'ok', nested: { count: 1 } },
    });
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.nested)).toBe(true);
  });

  test.each([
    { eventId: '' },
    { aggregateId: ' aggregate ' },
    { correlationId: '' },
    { causationId: '' },
    { occurredAt: new Date('invalid') },
  ])('rejects invalid envelope props %j', (override) => {
    expect(() => new TestEvent({
      eventId: 'event',
      aggregateId: 'aggregate',
      correlationId: 'correlation',
      occurredAt: new Date(),
      data: { value: 'ok', nested: { count: 1 } },
      ...override,
    })).toThrow();
  });

  test('rejects an invalid event version and non-JSON data', () => {
    const props = {
      eventId: 'event', aggregateId: 'aggregate', correlationId: 'correlation',
      occurredAt: new Date(), data: { value: 'ok', nested: { count: 1 } },
    };
    expect(() => new InvalidVersionEvent(props).toJSON()).toThrow(
      'version must be a positive integer',
    );
    expect(() => new TestEvent({
      ...props,
      data: { value: 'ok', nested: { count: Number.NaN } },
    })).toThrow('non-finite number');
  });
});
