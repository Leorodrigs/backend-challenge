import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import {
  parseEnvironment,
  type ApplicationConfiguration,
} from '../../src/config/application.config.js';
import { MessageFailureClassifier } from '../../src/messaging/sqs/message-failure.classifier.js';
import { InboxMessage } from '../../src/messaging/inbox/domain/inbox-message.js';
import { ProcessWagerSqsMessageUseCase } from '../../src/messaging/sqs/process-wager-sqs-message.use-case.js';
import { WagerTransactionSqsConsumer } from '../../src/messaging/sqs/wager-transaction-sqs.consumer.js';
import { WagerTransactionRequestedParser } from '../../src/messaging/sqs/wager-transaction-requested.parser.js';
import { Money } from '../../src/shared/domain/value-objects/money.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { PendingReferenceWorker } from '../../src/wagering/application/pending-reference.worker.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../src/wagering/application/wager-processing.persistence.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status.js';
import {
  createDisposableSqsQueues,
  createSqsClient,
  type DisposableSqsQueues,
} from '../helpers/sqs-test-queues.js';
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

function envelopeBody(
  messageId: string,
  input: ReturnType<typeof wagerInput>,
): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-09-05T12:00:00.000Z',
    data: {
      idempotencyKey: input.idempotencyKey,
      ...input.payload,
      money: input.payload.money.toJSON(),
    },
  });
}

async function sendBody(
  client: SQSClient,
  queues: DisposableSqsQueues,
  body: string,
  groupId = 'wallet-group',
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queues.sourceUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function receiveOne(
  client: SQSClient,
  queueUrl: string,
): Promise<Message | undefined> {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: [
        'ApproximateReceiveCount',
        'MessageGroupId',
      ],
      MessageAttributeNames: ['All'],
    }),
  );
  return response.Messages?.[0];
}

async function deleteDelivery(
  client: SQSClient,
  queueUrl: string,
  message: Message | undefined,
): Promise<void> {
  if (message?.ReceiptHandle === undefined) return;
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );
}

function consumerConfiguration(
  base: ApplicationConfiguration,
  queues: DisposableSqsQueues,
  overrides: Partial<ApplicationConfiguration['aws']> = {},
): ApplicationConfiguration {
  return {
    ...base,
    aws: {
      ...base.aws,
      wagerQueueUrl: queues.sourceUrl,
      wagerDlqUrl: queues.dlqUrl,
      sqsConsumerEnabled: false,
      sqsWaitTimeSeconds: 0,
      sqsVisibilityTimeout: 1,
      sqsMaxMessagesPerPoll: 1,
      sqsRetryBaseSeconds: 0,
      sqsRetryMaxSeconds: 0,
      sqsMaxReceiveAttempts: 3,
      sqsShutdownGraceMs: 100,
      ...overrides,
    },
  };
}

function buildConsumer(
  sqs: SQSClient,
  configuration: ApplicationConfiguration,
  persistence: WagerProcessingPersistence,
): {
  consumer: WagerTransactionSqsConsumer;
  processMessage: ProcessWagerSqsMessageUseCase;
} {
  const financial = new ProcessWagerTransactionUseCase(persistence);
  const classifier = new MessageFailureClassifier();
  const processMessage = new ProcessWagerSqsMessageUseCase(
    persistence,
    financial,
    configuration.aws.sqsConsumerName,
    undefined,
    classifier,
  );
  return {
    processMessage,
    consumer: new WagerTransactionSqsConsumer(
      sqs,
      processMessage,
      classifier,
      configuration,
    ),
  };
}

describe.skipIf(!shouldRun)('SQS Inbox processing with real PostgreSQL and LocalStack', () => {
  let database: WagerProcessingDatabase;
  let baseConfiguration: ApplicationConfiguration;
  let sqs: SQSClient;
  let queues: DisposableSqsQueues | undefined;
  let persistence: MikroOrmWagerProcessingPersistence;

  beforeAll(async () => {
    baseConfiguration = parseEnvironment(process.env);
    database = await createWagerProcessingDatabase();
    persistence = new MikroOrmWagerProcessingPersistence(database.orm.em);
    sqs = createSqsClient(baseConfiguration);
  }, 30_000);

  async function getQueues(): Promise<DisposableSqsQueues> {
    queues ??= await createDisposableSqsQueues(sqs);
    return queues;
  }

  afterAll(async () => {
    await queues?.close();
    sqs?.destroy();
    await database?.close();
  }, 30_000);

  test('Inbox schema round-trips the domain and enforces composite uniqueness and checks', async () => {
    const message = InboxMessage.receive({
      consumerName: 'wager-transactions-v1',
      messageId: `schema-${randomUUID()}`,
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date('2026-09-05T12:00:00.000Z'),
    });
    await persistence.transactional(async (context) => {
      expect(await context.inbox!.tryReceive(message)).toBe(true);
      const locked = await context.inbox!.findForUpdate(
        message.consumerName,
        message.messageId,
      );
      expect(locked?.payloadHash).toBe(message.payloadHash);
      locked?.markProcessed(new Date('2026-09-05T12:00:01.000Z'));
      if (locked === undefined) throw new Error('Expected Inbox row');
      await context.inbox!.save(locked);
    });
    await persistence.transactional(async (context) => {
      expect(await context.inbox!.tryReceive(message)).toBe(false);
      const locked = await context.inbox!.findForUpdate(
        message.consumerName,
        message.messageId,
      );
      expect(locked?.isProcessed()).toBe(true);
    });

    const primaryKey = await database.pool.query<{ columns: string[] }>(`
      select array_agg(att.attname order by ord.ordinality)::text[] as columns
      from pg_constraint con
      cross join lateral unnest(con.conkey) with ordinality ord(attnum, ordinality)
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = ord.attnum
      where con.conrelid = 'inbox_messages'::regclass and con.contype = 'p'
      group by con.oid
    `);
    expect(primaryKey.rows[0]?.columns).toEqual([
      'consumer_name',
      'message_id',
    ]);
    await expect(
      database.pool.query(
        `insert into inbox_messages
          (consumer_name, message_id, payload_hash, received_at, processed_at)
         values ('', 'invalid', $1, now(), null)`,
        ['a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ constraint: 'inbox_messages_consumer_name_not_blank_check' });
    await expect(
      database.pool.query(
        `insert into inbox_messages
          (consumer_name, message_id, payload_hash, received_at, processed_at)
         values ('consumer', 'invalid-hash', 'ABC', now(), null)`,
      ),
    ).rejects.toMatchObject({ constraint: 'inbox_messages_payload_hash_check' });
  }, 20_000);

  test('real happy path ACKs only after Inbox, BET, wallet and ledger commit', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const input = wagerInput(wallet, Kind.Bet);
      await sendBody(sqs, queues, envelopeBody('msg-happy', input), wallet.id);
      const { consumer } = buildConsumer(
        sqs,
        consumerConfiguration(baseConfiguration, queues),
        persistence,
      );

      expect(await consumer.pollOnce()).toBe(1);
      const inbox = await database.pool.query(
        `select * from inbox_messages
         where consumer_name = $1 and message_id = $2`,
        ['wager-transactions-v1', 'msg-happy'],
      );
      expect(inbox.rows).toHaveLength(1);
      expect(inbox.rows[0]?.processed_at).toBeInstanceOf(Date);
      await expectWalletState(database, wallet, '75.00', 2);
      expect((await loadLedger(database, input)).rows).toHaveLength(1);
      expect(await receiveOne(sqs, queues.sourceUrl)).toBeUndefined();
  }, 20_000);

  test('commit-before-ACK redelivery is Inbox-deduplicated and then ACKed', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const input = wagerInput(wallet, Kind.Bet);
      const body = envelopeBody('msg-crash', input);
      await sendBody(sqs, queues, body, wallet.id);
      const firstDelivery = await receiveOne(sqs, queues.sourceUrl);
      if (firstDelivery?.ReceiptHandle === undefined) {
        throw new Error('Expected the first real SQS delivery');
      }

      const configuration = consumerConfiguration(baseConfiguration, queues);
      const { consumer, processMessage } = buildConsumer(
        sqs,
        configuration,
        persistence,
      );
      const committed = await processMessage.execute(
        new WagerTransactionRequestedParser().parse(firstDelivery.Body),
      );
      expect(committed.outcome).toBe('PROCESSED');
      // Deliberately omit DeleteMessage: this is the simulated crash window.
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.sourceUrl,
          ReceiptHandle: firstDelivery.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );

      expect(await consumer.pollOnce()).toBe(1);
      await expectWalletState(database, wallet, '75.00', 2);
      expect((await loadLedger(database, input)).rows).toHaveLength(1);
      const counts = await database.pool.query<{
        inbox_count: string;
        wager_count: string;
      }>(
        `select
          (select count(*) from inbox_messages where message_id = $1)::text as inbox_count,
          (select count(*) from wager_transactions where idempotency_key = $2)::text as wager_count`,
        ['msg-crash', input.idempotencyKey],
      );
      expect(counts.rows[0]).toEqual({ inbox_count: '1', wager_count: '1' });
      expect(await receiveOne(sqs, queues.sourceUrl)).toBeUndefined();
  }, 20_000);

  test('same logical message with a different envelope is a permanent DLQ conflict', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const original = wagerInput(wallet, Kind.Bet);
      const changed = {
        ...original,
        payload: {
          ...original.payload,
          money: Money.from({ amount: '26.00', currency: 'BRL' }),
        },
      } as ReturnType<typeof wagerInput>;
      const configuration = consumerConfiguration(baseConfiguration, queues);
      const { consumer } = buildConsumer(sqs, configuration, persistence);
      await sendBody(sqs, queues, envelopeBody('msg-conflict', original), wallet.id);
      expect(await consumer.pollOnce()).toBe(1);
      const conflictingBody = envelopeBody('msg-conflict', changed);
      await sendBody(sqs, queues, conflictingBody, wallet.id);
      expect(await consumer.pollOnce()).toBe(1);

      const dlq = await receiveOne(sqs, queues.dlqUrl);
      expect(dlq?.Body).toBe(conflictingBody);
      expect(dlq?.MessageAttributes?.failureCategory?.StringValue).toBe(
        'permanent',
      );
      await deleteDelivery(sqs, queues.dlqUrl, dlq);
      await expectWalletState(database, wallet, '75.00', 2);
      expect((await loadLedger(database, original)).rows).toHaveLength(1);
      const inbox = await database.pool.query(
        'select * from inbox_messages where message_id = $1',
        ['msg-conflict'],
      );
      expect(inbox.rows).toHaveLength(1);
  }, 20_000);

  test('different messageIds retain separate Inbox rows and business replay remains unique', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const input = wagerInput(wallet, Kind.Bet);
      const configuration = consumerConfiguration(baseConfiguration, queues);
      const { consumer } = buildConsumer(sqs, configuration, persistence);
      await sendBody(sqs, queues, envelopeBody('msg-a', input), wallet.id);
      expect(await consumer.pollOnce()).toBe(1);
      await sendBody(sqs, queues, envelopeBody('msg-b', input), wallet.id);
      expect(await consumer.pollOnce()).toBe(1);

      const inbox = await database.pool.query(
        `select message_id from inbox_messages
         where message_id in ('msg-a', 'msg-b') order by message_id`,
      );
      expect(inbox.rows).toEqual([{ message_id: 'msg-a' }, { message_id: 'msg-b' }]);
      const wagers = await database.pool.query(
        'select id from wager_transactions where idempotency_key = $1',
        [input.idempotencyKey],
      );
      expect(wagers.rows).toHaveLength(1);
      expect((await loadLedger(database, input)).rows).toHaveLength(1);
      await expectWalletState(database, wallet, '75.00', 2);
  }, 20_000);

  test('business idempotency conflict commits its Inbox and ACKs without a DLQ retry', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const original = wagerInput(wallet, Kind.Bet);
      const conflicting = {
        ...original,
        payload: {
          ...original.payload,
          money: Money.from({ amount: '26.00', currency: 'BRL' }),
        },
      };
      const { consumer } = buildConsumer(
        sqs,
        consumerConfiguration(baseConfiguration, queues),
        persistence,
      );
      await sendBody(sqs, queues, envelopeBody('msg-business-a', original), wallet.id);
      expect(await consumer.pollOnce()).toBe(1);
      await sendBody(sqs, queues, envelopeBody('msg-business-b', conflicting), wallet.id);
      expect(await consumer.pollOnce()).toBe(1);

      const inbox = await database.pool.query(
        `select message_id, processed_at from inbox_messages
         where message_id in ('msg-business-a', 'msg-business-b')`,
      );
      expect(inbox.rows).toHaveLength(2);
      expect(inbox.rows.every(({ processed_at }) => processed_at instanceof Date)).toBe(true);
      expect(await receiveOne(sqs, queues.sourceUrl)).toBeUndefined();
      expect(await receiveOne(sqs, queues.dlqUrl)).toBeUndefined();
      await expectWalletState(database, wallet, '75.00', 2);
      expect((await loadLedger(database, original)).rows).toHaveLength(1);
  }, 20_000);

  test('failure after every financial flush rolls back Inbox and finance, then real redelivery succeeds', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const input = wagerInput(wallet, Kind.Bet);
      let fail = true;
      const failBeforeCommit: WagerProcessingPersistence = {
        transactional: <T>(
          work: (context: WagerProcessingContext) => Promise<T>,
        ) =>
          persistence.transactional((context) =>
            work({
              ...context,
              inbox: {
                tryReceive: (message) => context.inbox!.tryReceive(message),
                findForUpdate: (consumerName, messageId) =>
                  context.inbox!.findForUpdate(consumerName, messageId),
                save: async (message) => {
                  await context.inbox!.save(message);
                  if (fail) {
                    fail = false;
                    throw new Error('controlled pre-commit failure');
                  }
                },
              },
            }),
          ),
      };
      const recorded: unknown[] = [];
      const recordingClient = {
        send: async (command: unknown, options?: unknown) => {
          recorded.push(command);
          return await sqs.send(command as never, options as never);
        },
      } as unknown as SQSClient;
      const configuration = consumerConfiguration(baseConfiguration, queues);
      const { consumer } = buildConsumer(
        recordingClient,
        configuration,
        failBeforeCommit,
      );
      await sendBody(sqs, queues, envelopeBody('msg-rollback', input), wallet.id);

      expect(await consumer.pollOnce()).toBe(1);
      expect(
        recorded.some(
          (command) => command instanceof ChangeMessageVisibilityCommand,
        ),
      ).toBe(true);
      expect(
        await database.pool.query(
          'select 1 from inbox_messages where message_id = $1',
          ['msg-rollback'],
        ),
      ).toMatchObject({ rowCount: 0 });
      expect(
        await database.pool.query(
          'select 1 from wager_transactions where idempotency_key = $1',
          [input.idempotencyKey],
        ),
      ).toMatchObject({ rowCount: 0 });
      await expectWalletState(database, wallet, '100.00', 1);

      expect(await consumer.pollOnce()).toBe(1);
      await expectWalletState(database, wallet, '75.00', 2);
      expect((await loadLedger(database, input)).rows).toHaveLength(1);
  }, 20_000);

  test('malformed JSON moves immediately through real SendMessage/DeleteMessage to DLQ', async () => {
      const queues = await getQueues();
      const malformed = '{not-json';
      await sendBody(sqs, queues, malformed);
      const { consumer } = buildConsumer(
        sqs,
        consumerConfiguration(baseConfiguration, queues),
        persistence,
      );

      expect(await consumer.pollOnce()).toBe(1);
      const dlq = await receiveOne(sqs, queues.dlqUrl);
      expect(dlq?.Body).toBe(malformed);
      expect(dlq?.MessageAttributes?.failureCategory?.StringValue).toBe(
        'permanent',
      );
      await deleteDelivery(sqs, queues.dlqUrl, dlq);
      expect(await receiveOne(sqs, queues.sourceUrl)).toBeUndefined();
  }, 20_000);

  test('persistent transient failure reaches max attempts and moves through real DLQ', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const input = wagerInput(wallet, Kind.Bet);
      const recorded: unknown[] = [];
      const recordingClient = {
        send: async (command: unknown, options?: unknown) => {
          recorded.push(command);
          return await sqs.send(command as never, options as never);
        },
      } as unknown as SQSClient;
      const configuration = consumerConfiguration(baseConfiguration, queues, {
        sqsMaxReceiveAttempts: 3,
      });
      const alwaysUnavailable: WagerProcessingPersistence = {
        transactional: async () => {
          throw new Error('controlled database outage');
        },
      };
      const { consumer } = buildConsumer(
        recordingClient,
        configuration,
        alwaysUnavailable,
      );
      const body = envelopeBody('msg-exhausted', input);
      await sendBody(sqs, queues, body, wallet.id);

      expect(await consumer.pollOnce()).toBe(1);
      expect(await consumer.pollOnce()).toBe(1);
      expect(await consumer.pollOnce()).toBe(1);
      const visibilityChanges = recorded.filter(
        (command) => command instanceof ChangeMessageVisibilityCommand,
      ) as ChangeMessageVisibilityCommand[];
      expect(visibilityChanges).toHaveLength(2);
      expect(
        visibilityChanges.map((command) => command.input.VisibilityTimeout),
      ).toEqual([0, 0]);
      const sendIndex = recorded.findIndex(
        (command) => command instanceof SendMessageCommand,
      );
      const deleteIndex = recorded.findIndex(
        (command) => command instanceof DeleteMessageCommand,
      );
      expect(sendIndex).toBeGreaterThan(-1);
      expect(deleteIndex).toBeGreaterThan(sendIndex);
      const exhaustedDlq = await receiveOne(sqs, queues.dlqUrl);
      expect(exhaustedDlq?.Body).toBe(body);
      await deleteDelivery(sqs, queues.dlqUrl, exhaustedDlq);
      await expectWalletState(database, wallet, '100.00', 1);
      expect(
        await database.pool.query(
          'select 1 from inbox_messages where message_id = $1',
          ['msg-exhausted'],
        ),
      ).toMatchObject({ rowCount: 0 });
  }, 20_000);

  test('REFUND before BET is ACKed as PENDING_REFERENCE and resolved by the existing worker', async () => {
      const queues = await getQueues();
      const wallet = await seedWallet(database);
      const referenceExternalId = `bet-${randomUUID()}`;
      const roundId = `round-${randomUUID()}`;
      const refund = wagerInput(wallet, Kind.Refund, '25.00', {
        referenceExternalTransactionId: referenceExternalId,
        roundId,
      });
      const configuration = consumerConfiguration(baseConfiguration, queues);
      const { consumer } = buildConsumer(sqs, configuration, persistence);
      await sendBody(sqs, queues, envelopeBody('msg-refund', refund), wallet.id);
      expect(await consumer.pollOnce()).toBe(1);

      const pending = await database.pool.query<{ status: Status }>(
        'select status from wager_transactions where idempotency_key = $1',
        [refund.idempotencyKey],
      );
      expect(pending.rows[0]?.status).toBe(Status.PendingReference);
      expect(await receiveOne(sqs, queues.sourceUrl)).toBeUndefined();
      const inbox = await database.pool.query<{ processed_at: Date | null }>(
        'select processed_at from inbox_messages where message_id = $1',
        ['msg-refund'],
      );
      expect(inbox.rows[0]?.processed_at).toBeInstanceOf(Date);

      const bet = wagerInput(wallet, Kind.Bet, '25.00', {
        externalTransactionId: referenceExternalId,
        roundId,
      });
      await sendBody(sqs, queues, envelopeBody('msg-bet', bet), wallet.id);
      expect(await consumer.pollOnce()).toBe(1);
      const worker = new PendingReferenceWorker(persistence);
      const results = await worker.runOnce(
        new Date(Date.now() + 2_000),
        1,
      );
      expect(results[0]?.status).toBe(Status.Processed);
      await expectWalletState(database, wallet, '100.00', 3);
      expect((await loadLedger(database, bet)).rows).toHaveLength(1);
      expect((await loadLedger(database, refund)).rows).toHaveLength(1);
  }, 20_000);
});
