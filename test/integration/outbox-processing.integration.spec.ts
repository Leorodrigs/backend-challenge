import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { IntegrationEventPublisher } from '../../src/messaging/outbox/application/integration-event.publisher.js';
import { OutboxPublisherWorker } from '../../src/messaging/outbox/application/outbox-publisher.worker.js';
import { OutboxMessage } from '../../src/messaging/outbox/domain/outbox-message.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { MikroOrmOutboxMessageRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-outbox-message.repository.js';
import { ClaimedWagerTransactionProcessor } from '../../src/wagering/application/claimed-wager-transaction.processor.js';
import { PendingReferenceRetryPolicy } from '../../src/wagering/application/pending-reference-retry-policy.js';
import { PendingReferenceWorker } from '../../src/wagering/application/pending-reference.worker.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from '../../src/wagering/application/wager-processing.persistence.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status.js';
import {
  createWagerProcessingDatabase,
  type WagerProcessingDatabase,
} from '../helpers/wager-processing-database.js';
import {
  expectWalletState,
  loadLedger,
  seedWallet,
  wagerInput,
} from '../helpers/wager-processing-fixtures.js';

const shouldRun = process.env.RUN_INTEGRATION_TESTS === 'true';

function directMessage(id = randomUUID(), occurredAt = new Date()): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId: `aggregate-${id}`,
    eventType: 'TestIntegrationEvent',
    payload: {
      eventId: id,
      eventType: 'TestIntegrationEvent',
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

const publisherOptions = {
  enabled: false,
  batchSize: 100,
  pollIntervalMs: 10,
  retryBaseMs: 10,
  retryMaxMs: 100,
};

describe.skipIf(!shouldRun)('Transactional Outbox in real PostgreSQL', () => {
  let database: WagerProcessingDatabase;
  let persistence: MikroOrmWagerProcessingPersistence;
  let useCase: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    database = await createWagerProcessingDatabase();
    persistence = new MikroOrmWagerProcessingPersistence(database.orm.em);
    useCase = new ProcessWagerTransactionUseCase(persistence);
  }, 30_000);

  afterAll(async () => { await database?.close(); }, 30_000);

  async function eventTypes(transactionId: string): Promise<string[]> {
    const result = await database.pool.query<{ event_type: string }>(
      `select event_type from outbox_messages
       where payload->'data'->>'transactionId' = $1 order by event_type`,
      [transactionId],
    );
    return result.rows.map(({ event_type }) => event_type);
  }

  async function settleExistingOutbox(): Promise<void> {
    await database.pool.query(
      'update outbox_messages set published_at = greatest(current_timestamp, occurred_at), next_attempt_at = null where published_at is null',
    );
  }

  test('schema, JSONB mapping, checks, partial index, and transaction guard are real', async () => {
    const message = directMessage();
    await persistence.transactional(async (context) => {
      await context.outbox.append(message);
      const claimed = await context.outbox.claimNextDue(new Date());
      expect(claimed?.id).toBe(message.id);
      claimed?.markPublished(new Date());
      if (claimed === undefined) throw new Error('Expected a claimed Outbox row');
      await context.outbox.save(claimed);
    });
    const stored = await new MikroOrmOutboxMessageRepository(
      database.orm.em.fork(),
    ).findById(message.id);
    expect(stored?.payload).toEqual(message.payload);
    expect(stored?.publishedAt).toBeInstanceOf(Date);

    const schema = await database.pool.query<{
      payload_type: string;
      primary_columns: string[];
      index_definition: string;
    }>(`
      select
        (select data_type from information_schema.columns
         where table_name = 'outbox_messages' and column_name = 'payload') as payload_type,
        (select array_agg(att.attname order by ord.ordinality)::text[]
         from pg_constraint con
         cross join lateral unnest(con.conkey) with ordinality ord(attnum, ordinality)
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = ord.attnum
         where con.conrelid = 'outbox_messages'::regclass and con.contype = 'p') as primary_columns,
        (select indexdef from pg_indexes where indexname = 'outbox_messages_pending_due_index') as index_definition
    `);
    expect(schema.rows[0]?.payload_type).toBe('jsonb');
    expect(schema.rows[0]?.primary_columns).toEqual(['id']);
    expect(schema.rows[0]?.index_definition).toContain('WHERE (published_at IS NULL)');

    await expect(database.pool.query(
      `insert into outbox_messages
       (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       values ('', 'aggregate', 'Type', '{}', now(), 0, now(), null)`,
    )).rejects.toMatchObject({ constraint: 'outbox_messages_id_not_blank_check' });
    await expect(database.pool.query(
      `insert into outbox_messages
       (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       values ($1, 'aggregate', 'Type', '[]', now(), 0, now(), null)`,
      [randomUUID()],
    )).rejects.toMatchObject({ constraint: 'outbox_messages_payload_object_check' });
    await expect(
      new MikroOrmOutboxMessageRepository(database.orm.em.fork())
        .claimNextDue(new Date()),
    ).rejects.toThrow('An open transaction is required');
  }, 20_000);

  test('financial result matrix creates only the required integration events', async () => {
    for (const [kind, amount, balance, expected] of [
      [Kind.Bet, '25.00', '75.00', ['WagerTransactionProcessed', 'WalletBalanceChanged']],
      [Kind.Win, '25.00', '125.00', ['WagerTransactionProcessed', 'WalletBalanceChanged']],
      [Kind.Loss, '25.00', '100.00', ['WagerTransactionProcessed']],
      [Kind.Bet, '125.00', '100.00', ['WagerTransactionRejected']],
    ] as const) {
      const wallet = await seedWallet(database);
      const result = await useCase.execute(wagerInput(wallet, kind, amount));
      await expectWalletState(database, wallet, balance, kind === Kind.Bet && amount === '25.00' || kind === Kind.Win ? 2 : 1);
      expect(await eventTypes(result.transactionId)).toEqual([...expected].sort());
    }

    const wallet = await seedWallet(database);
    const referenceExternalTransactionId = `reference-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      referenceExternalTransactionId,
      roundId,
    });
    const pending = await useCase.execute(refund);
    expect(pending.status).toBe(Status.PendingReference);
    expect(await eventTypes(pending.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    const worker = new PendingReferenceWorker(persistence);
    await worker.runOnce(new Date(Date.now() + 2_000), 1);
    expect(await eventTypes(pending.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    const bet = wagerInput(wallet, Kind.Bet, '25.00', {
      externalTransactionId: referenceExternalTransactionId,
      roundId,
    });
    await useCase.execute(bet);
    const resolved = await worker.runOnce(new Date(Date.now() + 10_000), 1);
    expect(resolved[0]?.status).toBe(Status.Processed);
    expect(await eventTypes(pending.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectWalletState(database, wallet, '100.00', 3);

    const exhaustionWallet = await seedWallet(database);
    const limitedProcessor = new ClaimedWagerTransactionProcessor(
      new PendingReferenceRetryPolicy({ maxAttempts: 2 }),
    );
    const limitedUseCase = new ProcessWagerTransactionUseCase(
      persistence,
      limitedProcessor,
    );
    const limitedWorker = new PendingReferenceWorker(persistence, limitedProcessor);
    const exhaustedInput = wagerInput(exhaustionWallet, Kind.Refund, '25.00', {
      referenceExternalTransactionId: `missing-${randomUUID()}`,
    });
    const initial = await limitedUseCase.execute(exhaustedInput);
    const exhausted = await limitedWorker.runOnce(new Date(Date.now() + 2_000), 1);
    expect(exhausted[0]?.status).toBe(Status.Rejected);
    expect(await eventTypes(initial.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  }, 30_000);

  test('Wager, Wallet, Ledger, and Outbox flushes roll back in the same transaction', async () => {
    await settleExistingOutbox();
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const failure = new Error('controlled failure after financial and Outbox flushes');
    const failing: WagerProcessingPersistence = {
      transactional: (work) => persistence.transactional(async (context) => {
        const result = await work(context);
        expect(await context.outbox.claimNextDue(new Date())).toBeDefined();
        throw failure;
      }),
    };
    await expect(new ProcessWagerTransactionUseCase(failing).execute(input)).rejects.toBe(failure);
    await expectWalletState(database, wallet, '100.00', 1);
    expect((await loadLedger(database, input)).rows).toHaveLength(0);
    const rows = await database.pool.query(
      `select 1 from outbox_messages
       where payload->'data'->>'externalTransactionId' = $1`,
      [input.payload.externalTransactionId],
    );
    expect(rows.rows).toHaveLength(0);
  }, 20_000);

  test('idempotent replay does not create new Outbox rows', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const first = await useCase.execute(input);
    const replay = await useCase.execute(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(await eventTypes(first.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('SNS failure commits retry metadata and the row becomes claimable only when due', async () => {
    await settleExistingOutbox();
    const pending = directMessage(randomUUID(), new Date(Date.now() - 1_000));
    await persistence.transactional((context) => context.outbox.append(pending));
    const publish = async (): Promise<void> => { throw new Error('controlled SNS failure'); };
    const worker = new OutboxPublisherWorker(
      persistence,
      { publish } as IntegrationEventPublisher,
      publisherOptions,
    );
    const now = new Date();
    expect(await worker.runOnce(now)).toEqual(['RETRY_SCHEDULED']);
    const failed = await new MikroOrmOutboxMessageRepository(
      database.orm.em.fork(),
    ).findById(pending.id);
    expect(failed?.attempts).toBe(1);
    expect(failed?.publishedAt).toBeUndefined();
    expect(failed?.nextAttemptAt?.getTime()).toBe(now.getTime() + 10);
    expect(await worker.runOnce(new Date(now.getTime() + 9))).toEqual([]);

    const published: string[] = [];
    const recovery = new OutboxPublisherWorker(
      persistence,
      { publish: async (message) => { published.push(message.id); } },
      publisherOptions,
    );
    expect(await recovery.runOnce(new Date(now.getTime() + 10))).toEqual(['PUBLISHED']);
    expect(published).toEqual([pending.id]);
  }, 20_000);

  test('a fresh publisher recovers events committed before any publish attempt', async () => {
    await settleExistingOutbox();
    const wallet = await seedWallet(database);
    const result = await useCase.execute(wagerInput(wallet, Kind.Bet));
    const pending = await database.pool.query<{ id: string }>(
      `select id from outbox_messages
       where payload->'data'->>'transactionId' = $1 and published_at is null`,
      [result.transactionId],
    );
    expect(pending.rows).toHaveLength(2);

    const published: string[] = [];
    const newWorker = new OutboxPublisherWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
      { publish: async (message) => { published.push(message.id); } },
      publisherOptions,
    );
    expect(await newWorker.runOnce(new Date())).toEqual(['PUBLISHED', 'PUBLISHED']);
    expect(new Set(published)).toEqual(new Set(pending.rows.map(({ id }) => id)));
    const remaining = await database.pool.query(
      `select 1 from outbox_messages
       where payload->'data'->>'transactionId' = $1 and published_at is null`,
      [result.transactionId],
    );
    expect(remaining.rows).toHaveLength(0);
  }, 20_000);
});
