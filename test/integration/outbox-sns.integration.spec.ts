import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SNSClient } from '@aws-sdk/client-sns';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { parseEnvironment } from '../../src/config/application.config.js';
import { OutboxPublisherWorker } from '../../src/messaging/outbox/application/outbox-publisher.worker.js';
import { OutboxMessage } from '../../src/messaging/outbox/domain/outbox-message.js';
import { SnsIntegrationEventPublisher } from '../../src/messaging/outbox/infrastructure/sns-integration-event.publisher.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../src/wagering/application/wager-processing.persistence.js';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { createSqsClient } from '../helpers/sqs-test-queues.js';
import {
  createWagerProcessingDatabase,
  type WagerProcessingDatabase,
} from '../helpers/wager-processing-database.js';
import { seedWallet, wagerInput } from '../helpers/wager-processing-fixtures.js';

const shouldRun = process.env.RUN_INTEGRATION_TESTS === 'true';

interface EventEnvelope {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}

const workerOptions = {
  enabled: false,
  batchSize: 10,
  pollIntervalMs: 10,
  retryBaseMs: 10,
  retryMaxMs: 100,
};

describe.skipIf(!shouldRun)('Outbox publication through real LocalStack SNS', () => {
  let database: WagerProcessingDatabase;
  let persistence: MikroOrmWagerProcessingPersistence;
  let sns: SNSClient;
  let sqs: SQSClient;
  let auditQueueUrl: string;
  let topicArn: string;

  beforeAll(async () => {
    const configuration = parseEnvironment(process.env);
    database = await createWagerProcessingDatabase();
    persistence = new MikroOrmWagerProcessingPersistence(database.orm.em);
    sqs = createSqsClient(configuration);
    sns = new SNSClient({
      region: configuration.aws.region,
      ...(configuration.aws.endpoint === undefined ? {} : { endpoint: configuration.aws.endpoint }),
      ...(configuration.aws.accessKeyId === undefined || configuration.aws.secretAccessKey === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: configuration.aws.accessKeyId,
              secretAccessKey: configuration.aws.secretAccessKey,
            },
          }),
    });
    topicArn = configuration.aws.integrationEventsTopicArn;
    const audit = await sqs.send(new GetQueueUrlCommand({
      QueueName: 'wager-integration-events-audit',
    }));
    if (audit.QueueUrl === undefined) throw new Error('LocalStack audit queue is unavailable');
    auditQueueUrl = audit.QueueUrl;
    await drainAuditQueue();
  }, 30_000);

  afterAll(async () => {
    sns?.destroy();
    sqs?.destroy();
    await database?.close();
  }, 30_000);

  async function drainAuditQueue(): Promise<void> {
    for (;;) {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: auditQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }));
      if (response.Messages === undefined || response.Messages.length === 0) return;
      for (const message of response.Messages) {
        if (message.ReceiptHandle !== undefined) {
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: auditQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }));
        }
      }
    }
  }

  async function receiveEvents(
    eventIds: ReadonlySet<string>,
    count: number,
  ): Promise<EventEnvelope[]> {
    const found: EventEnvelope[] = [];
    const deadline = Date.now() + 10_000;
    while (found.length < count && Date.now() < deadline) {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: auditQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }));
      for (const message of response.Messages ?? []) {
        if (message.Body !== undefined) {
          const envelope = JSON.parse(message.Body) as EventEnvelope;
          if (eventIds.has(envelope.eventId)) found.push(envelope);
        }
        if (message.ReceiptHandle !== undefined) {
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: auditQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }));
        }
      }
    }
    return found;
  }

  test('a fresh worker publishes committed financial events to the raw audit queue', async () => {
    const wallet = await seedWallet(database);
    const result = await new ProcessWagerTransactionUseCase(persistence).execute(
      wagerInput(wallet, WagerTransactionKind.Bet),
    );
    const pending = await database.pool.query<{ id: string }>(
      `select id from outbox_messages
       where payload->'data'->>'transactionId' = $1 and published_at is null`,
      [result.transactionId],
    );
    expect(pending.rows).toHaveLength(2);
    const eventIds = new Set(pending.rows.map(({ id }) => id));

    const publisher = new SnsIntegrationEventPublisher(sns, topicArn);
    const restartedWorker = new OutboxPublisherWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
      publisher,
      workerOptions,
    );
    expect(await restartedWorker.runOnce(new Date())).toEqual([
      'PUBLISHED',
      'PUBLISHED',
    ]);

    const received = await receiveEvents(eventIds, 2);
    expect(received).toHaveLength(2);
    expect(received.map(({ eventType }) => eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const envelope of received) {
      expect(typeof envelope.aggregateId).toBe('string');
      expect(envelope.correlationId).toBe(result.transactionId);
      expect(typeof envelope.occurredAt).toBe('string');
      expect(envelope.version).toBe(1);
      expect(typeof envelope.data).toBe('object');
      expect(eventIds.has(envelope.eventId)).toBe(true);
      const money = envelope.data.money as { amount: unknown; currency: unknown };
      expect(money).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(typeof money.amount).toBe('string');
    }
    const published = await database.pool.query(
      `select published_at from outbox_messages
       where payload->'data'->>'transactionId' = $1 and published_at is not null`,
      [result.transactionId],
    );
    expect(published.rows).toHaveLength(2);
  }, 30_000);

  test('publish-before-mark rollback causes a duplicate with the same eventId and envelope', async () => {
    await drainAuditQueue();
    const id = randomUUID();
    const occurredAt = new Date(Date.now() - 1_000);
    const message = OutboxMessage.rehydrate({
      id,
      aggregateId: `aggregate-${id}`,
      eventType: 'CrashRecoveryEvent',
      payload: {
        eventId: id,
        eventType: 'CrashRecoveryEvent',
        aggregateId: `aggregate-${id}`,
        correlationId: `correlation-${id}`,
        occurredAt: occurredAt.toISOString(),
        version: 1,
        data: { recovery: true },
      },
      occurredAt,
      attempts: 0,
      nextAttemptAt: occurredAt,
      publishedAt: undefined,
    });
    await persistence.transactional((context) => context.outbox.append(message));

    const failAfterPublish: WagerProcessingPersistence = {
      transactional: <T>(work: (context: WagerProcessingContext) => Promise<T>) =>
        persistence.transactional((context) => work({
          ...context,
          outbox: {
            append: (item) => context.outbox.append(item),
            claimNextDue: (now) => context.outbox.claimNextDue(now),
            save: async (item) => {
              await context.outbox.save(item);
              throw new Error('controlled crash before Outbox commit');
            },
          },
        })),
    };
    const publisher = new SnsIntegrationEventPublisher(sns, topicArn);
    const crashingWorker = new OutboxPublisherWorker(
      failAfterPublish,
      publisher,
      { ...workerOptions, batchSize: 1 },
    );
    await expect(crashingWorker.runOnce(new Date())).rejects.toThrow(
      'controlled crash before Outbox commit',
    );
    const afterCrash = await database.pool.query<{
      attempts: number;
      published_at: Date | null;
    }>('select attempts, published_at from outbox_messages where id = $1', [id]);
    expect(afterCrash.rows[0]).toEqual({ attempts: 0, published_at: null });

    const recoveryWorker = new OutboxPublisherWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
      publisher,
      { ...workerOptions, batchSize: 1 },
    );
    expect(await recoveryWorker.runOnce(new Date())).toEqual(['PUBLISHED']);
    const duplicates = await receiveEvents(new Set([id]), 2);
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map(({ eventId }) => eventId)).toEqual([id, id]);
    expect(duplicates[0]).toEqual(duplicates[1]);
    expect(duplicates[0]).toEqual(message.payload as unknown as EventEnvelope);
  }, 30_000);
});
