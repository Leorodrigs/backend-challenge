import { describe, expect, mock, test } from 'bun:test';

import type { IntegrationEventPublisher } from '../../../../src/messaging/outbox/application/integration-event.publisher.js';
import { ApplicationMetrics } from '../../../../src/observability/application-metrics.js';
import { OutboxPublisherWorker } from '../../../../src/messaging/outbox/application/outbox-publisher.worker.js';
import { OutboxMessage } from '../../../../src/messaging/outbox/domain/outbox-message.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../../../src/wagering/application/wager-processing.persistence.js';

const occurredAt = new Date('2026-09-05T12:00:00.000Z');

function message(id: string): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId: `aggregate-${id}`,
    eventType: 'TestEvent',
    payload: {
      eventId: id,
      eventType: 'TestEvent',
      aggregateId: `aggregate-${id}`,
      correlationId: `correlation-${id}`,
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data: { value: id },
    },
    occurredAt,
    attempts: 0,
    nextAttemptAt: occurredAt,
    publishedAt: undefined,
  });
}

function persistenceFor(messages: OutboxMessage[]): WagerProcessingPersistence {
  const context = {
    outbox: {
      append: mock(async (value: OutboxMessage) => { messages.push(value); }),
      claimNextDue: mock(async (now: Date) => messages.find((item) => item.isDue(now))),
      save: mock(async () => {}),
    },
  } as unknown as WagerProcessingContext;
  return {
    transactional: async <T>(work: (context: WagerProcessingContext) => Promise<T>) =>
      work(context),
  };
}

const options = {
  enabled: false,
  batchSize: 10,
  pollIntervalMs: 10,
  retryBaseMs: 100,
  retryMaxMs: 500,
};

describe('OutboxPublisherWorker', () => {
  test('publishes each due item in its own transaction and marks it published', async () => {
    const messages = [message('a'), message('b')];
    let transactions = 0;
    const base = persistenceFor(messages);
    const persistence: WagerProcessingPersistence = {
      transactional: async (work) => {
        transactions += 1;
        return base.transactional(work);
      },
    };
    const publish = mock(async () => {});
    const worker = new OutboxPublisherWorker(
      persistence,
      { publish } as IntegrationEventPublisher,
      options,
    );

    expect(await worker.runOnce(occurredAt)).toEqual(['PUBLISHED', 'PUBLISHED']);
    expect(transactions).toBe(3);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(messages.every((item) => !item.isPending())).toBe(true);
    expect(await worker.runOnce(occurredAt)).toEqual([]);
  });

  test('commits retry metadata after an SNS failure and skips the item before due', async () => {
    const pending = message('retry');
    const metrics = new ApplicationMetrics();
    const publish = mock(async () => { throw new Error('SNS unavailable'); });
    const worker = new OutboxPublisherWorker(
      persistenceFor([pending]),
      { publish } as IntegrationEventPublisher,
      options,
      metrics,
    );

    expect(await worker.runOnce(occurredAt)).toEqual(['RETRY_SCHEDULED']);
    expect(pending.attempts).toBe(1);
    expect(pending.publishedAt).toBeUndefined();
    expect(pending.nextAttemptAt?.getTime()).toBe(occurredAt.getTime() + 100);
    expect(await worker.runOnce(new Date(occurredAt.getTime() + 99))).toEqual([]);
    expect(await metrics.metrics()).toContain(
      'wager_retries_total{component="outbox"} 1',
    );
  });

  test('suppresses overlapping iterations locally while an in-flight publish finishes', async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const worker = new OutboxPublisherWorker(
      persistenceFor([message('held')]),
      { publish: async () => { started.resolve(); await gate.promise; } },
      options,
    );
    const first = worker.runOnce(occurredAt);
    await started.promise;
    expect(await worker.runOnce(occurredAt)).toEqual([]);
    gate.resolve();
    expect(await first).toEqual(['PUBLISHED']);
  });
});
