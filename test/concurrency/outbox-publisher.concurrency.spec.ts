import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { IntegrationEventPublisher } from '../../src/messaging/outbox/application/integration-event.publisher.js';
import { OutboxPublisherWorker } from '../../src/messaging/outbox/application/outbox-publisher.worker.js';
import { OutboxMessage } from '../../src/messaging/outbox/domain/outbox-message.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import {
  createWagerProcessingDatabase,
  type WagerProcessingDatabase,
} from '../helpers/wager-processing-database.js';

const shouldRun = process.env.RUN_INTEGRATION_TESTS === 'true';

function message(id: string, occurredAt: Date): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId: `aggregate-${id}`,
    eventType: 'ConcurrencyEvent',
    payload: {
      eventId: id,
      eventType: 'ConcurrencyEvent',
      aggregateId: `aggregate-${id}`,
      correlationId: `correlation-${id}`,
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data: { id },
    },
    occurredAt,
    attempts: 0,
    nextAttemptAt: occurredAt,
    publishedAt: undefined,
  });
}

const options = {
  enabled: false,
  batchSize: 1,
  pollIntervalMs: 10,
  retryBaseMs: 10,
  retryMaxMs: 100,
};

describe.skipIf(!shouldRun)('concurrent Outbox publishers in real PostgreSQL', () => {
  let database: WagerProcessingDatabase;
  const queries: string[] = [];

  beforeAll(async () => {
    database = await createWagerProcessingDatabase((sql) => queries.push(sql));
  }, 30_000);

  afterAll(async () => { await database?.close(); }, 30_000);

  async function append(...messages: OutboxMessage[]): Promise<void> {
    const persistence = new MikroOrmWagerProcessingPersistence(database.orm.em.fork());
    await persistence.transactional(async (context) => {
      for (const item of messages) await context.outbox.append(item);
    });
  }

  test('a second publisher SKIP LOCKEDs the same row instead of publishing it', async () => {
    const id = `same-${randomUUID()}`;
    const now = new Date();
    await append(message(id, new Date(now.getTime() - 1_000)));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publishedA: string[] = [];
    const publishedB: string[] = [];
    const workerA = new OutboxPublisherWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
      {
        publish: async (item) => {
          publishedA.push(item.id);
          started.resolve();
          await release.promise;
        },
      },
      options,
    );
    const workerB = new OutboxPublisherWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
      { publish: async (item) => { publishedB.push(item.id); } },
      options,
    );

    const first = workerA.runOnce(now);
    await started.promise;
    expect(await workerB.runOnce(now)).toEqual([]);
    expect(publishedB).toEqual([]);
    release.resolve();
    expect(await first).toEqual(['PUBLISHED']);
    expect(publishedA).toEqual([id]);
    expect(queries.some((sql) => /for update skip locked/i.test(sql))).toBe(true);
  }, 20_000);

  test('another publisher claims a different row while the first row remains locked', async () => {
    const prefix = randomUUID();
    const now = new Date();
    const firstId = `a-${prefix}`;
    const secondId = `b-${prefix}`;
    await append(
      message(firstId, new Date(now.getTime() - 2_000)),
      message(secondId, new Date(now.getTime() - 1_000)),
    );
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publishedA: string[] = [];
    const publishedB: string[] = [];
    const workerA = new OutboxPublisherWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
      {
        publish: async (item) => {
          publishedA.push(item.id);
          started.resolve();
          await release.promise;
        },
      } as IntegrationEventPublisher,
      options,
    );
    const workerB = new OutboxPublisherWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
      { publish: async (item) => { publishedB.push(item.id); } },
      options,
    );

    const first = workerA.runOnce(now);
    await started.promise;
    expect(await workerB.runOnce(now)).toEqual(['PUBLISHED']);
    expect(publishedB).toEqual([secondId]);
    release.resolve();
    expect(await first).toEqual(['PUBLISHED']);
    expect(publishedA).toEqual([firstId]);
  }, 20_000);
});
