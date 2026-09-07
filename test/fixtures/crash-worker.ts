// Test image only. No production endpoints, environment switches or crash hooks.
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SNSClient } from '@aws-sdk/client-sns';
import { loadApplicationConfiguration } from '../../src/config/application.config.js';
import { createMikroOrmOptions } from '../../src/persistence/mikro-orm/mikro-orm.options.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { ProcessWagerSqsMessageUseCase } from '../../src/messaging/sqs/process-wager-sqs-message.use-case.js';
import { WagerTransactionSqsConsumer } from '../../src/messaging/sqs/wager-transaction-sqs.consumer.js';
import { MessageFailureClassifier } from '../../src/messaging/sqs/message-failure.classifier.js';
import { OutboxPublisherWorker } from '../../src/messaging/outbox/application/outbox-publisher.worker.js';
import { SnsIntegrationEventPublisher } from '../../src/messaging/outbox/infrastructure/sns-integration-event.publisher.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { Money } from '../../src/shared/domain/value-objects/money.js';
import { WalletEntity } from '../../src/persistence/mikro-orm/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../src/persistence/mikro-orm/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../src/persistence/mikro-orm/entities/wallet-ledger-entry.entity.js';
import { InboxMessageEntity } from '../../src/persistence/mikro-orm/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../../src/persistence/mikro-orm/entities/outbox-message.entity.js';

const configuration = loadApplicationConfiguration();
const orm = await MikroORM.init({ ...createMikroOrmOptions(configuration),
  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity], entitiesTs: [] });
const persistence = new MikroOrmWagerProcessingPersistence(orm.em);
const mode = process.argv[2];
const clientConfig = { region: configuration.aws.region, ...(configuration.aws.endpoint === undefined ? {} : { endpoint: configuration.aws.endpoint }),
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 };
const hold = async (details: object): Promise<never> => {
  await Bun.write('/tmp/wager-fixture.json', JSON.stringify(details));
  console.log(`FIXTURE_BARRIER ${JSON.stringify(details)}`);
  setInterval(() => {}, 1000);
  return new Promise<never>(() => {});
};
if (mode === 'commit-before-publish') {
  const wallet = await new CreateWalletUseCase(persistence).execute({ playerId: process.argv[3]!, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
  await hold({ mode, walletId: wallet.id, pid: process.pid });
} else if (mode === 'publish-before-mark') {
  const sns = new SNSClient(clientConfig);
  sns.middlewareStack.add((next, context) => async (args) => {
    const result = await next(args);
    if (context.commandName === 'PublishCommand') await hold({ mode, input: args.input, pid: process.pid });
    return result;
  }, { step: 'initialize', name: 'testCrashAfterPublish' });
  const worker = new OutboxPublisherWorker(persistence,
    new SnsIntegrationEventPublisher(sns, configuration.aws.integrationEventsTopicArn),
    { enabled: false, batchSize: 1, pollIntervalMs: 100, retryBaseMs: 100, retryMaxMs: 1000 });
  await worker.runOnce();
  throw new Error('Fixture expected a pending outbox event');
} else {
  const sqs = new SQSClient({ ...clientConfig, useQueueUrlAsEndpoint: false });
  sqs.middlewareStack.add((next, context) => async (args) => {
    if (context.commandName === 'ReceiveMessageCommand') console.log('FIXTURE_RECEIVE');
    if (context.commandName === 'DeleteMessageCommand' && mode === 'commit-before-ack') {
      await hold({ mode, pid: process.pid });
    }
    return next(args);
  }, { step: 'initialize', name: 'testCrashBeforeAck' });
  const consumer = new WagerTransactionSqsConsumer(sqs,
    new ProcessWagerSqsMessageUseCase(persistence, new ProcessWagerTransactionUseCase(persistence), configuration.aws.sqsConsumerName),
    new MessageFailureClassifier(), configuration);
  process.on('SIGTERM', async () => {
    console.log('FIXTURE_SIGTERM');
    await consumer.beforeApplicationShutdown();
    await orm.close(true);
    sqs.destroy();
    console.log('FIXTURE_DRAINED');
    process.exit(0);
  });
  consumer.onModuleInit();
}
