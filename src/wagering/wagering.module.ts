import type { SNSClient } from '@aws-sdk/client-sns';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../config/application.config.js';
import { SNS_CLIENT, SQS_CLIENT } from '../messaging/aws/aws.constants.js';
import { AwsModule } from '../messaging/aws/aws.module.js';
import { MessageFailureClassifier } from '../messaging/sqs/message-failure.classifier.js';
import { ProcessWagerSqsMessageUseCase } from '../messaging/sqs/process-wager-sqs-message.use-case.js';
import { WagerTransactionSqsConsumer } from '../messaging/sqs/wager-transaction-sqs.consumer.js';
import { IntegrationEventPublisher } from '../messaging/outbox/application/integration-event.publisher.js';
import { OutboxPublisherWorker } from '../messaging/outbox/application/outbox-publisher.worker.js';
import { SnsIntegrationEventPublisher } from '../messaging/outbox/infrastructure/sns-integration-event.publisher.js';
import { PersistenceModule } from '../persistence/mikro-orm/persistence.module.js';
import { ClaimedWagerTransactionProcessor } from './application/claimed-wager-transaction.processor.js';
import { PendingReferenceRetryPolicy } from './application/pending-reference-retry-policy.js';
import { PendingReferenceWorker } from './application/pending-reference.worker.js';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case.js';
import { WagerProcessingPersistence } from './application/wager-processing.persistence.js';
import { PendingReferenceScheduler } from './pending-reference.scheduler.js';

@Module({
  imports: [PersistenceModule, AwsModule],
  providers: [
    {
      provide: ClaimedWagerTransactionProcessor,
      inject: [applicationConfiguration.KEY],
      useFactory: ({ workers }: ApplicationConfiguration) =>
        new ClaimedWagerTransactionProcessor(
          new PendingReferenceRetryPolicy({
            baseDelayMs: workers.referenceRetryBaseMs,
            maxDelayMs: workers.referenceRetryMaxMs,
            ttlMs: workers.referenceTtlMs,
          }),
        ),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [WagerProcessingPersistence, ClaimedWagerTransactionProcessor],
      useFactory: (
        persistence: WagerProcessingPersistence,
        processor: ClaimedWagerTransactionProcessor,
      ) => new ProcessWagerTransactionUseCase(persistence, processor),
    },
    {
      provide: PendingReferenceWorker,
      inject: [WagerProcessingPersistence, ClaimedWagerTransactionProcessor],
      useFactory: (
        persistence: WagerProcessingPersistence,
        processor: ClaimedWagerTransactionProcessor,
      ) => new PendingReferenceWorker(persistence, processor),
    },
    MessageFailureClassifier,
    {
      provide: ProcessWagerSqsMessageUseCase,
      inject: [
        WagerProcessingPersistence,
        ProcessWagerTransactionUseCase,
        applicationConfiguration.KEY,
        MessageFailureClassifier,
      ],
      useFactory: (
        persistence: WagerProcessingPersistence,
        useCase: ProcessWagerTransactionUseCase,
        configuration: ApplicationConfiguration,
        classifier: MessageFailureClassifier,
      ) =>
        new ProcessWagerSqsMessageUseCase(
          persistence,
          useCase,
          configuration.aws.sqsConsumerName,
          undefined,
          classifier,
        ),
    },
    {
      provide: WagerTransactionSqsConsumer,
      inject: [
        SQS_CLIENT,
        ProcessWagerSqsMessageUseCase,
        MessageFailureClassifier,
        applicationConfiguration.KEY,
      ],
      useFactory: (
        sqsClient: SQSClient,
        useCase: ProcessWagerSqsMessageUseCase,
        classifier: MessageFailureClassifier,
        configuration: ApplicationConfiguration,
      ) =>
        new WagerTransactionSqsConsumer(
          sqsClient,
          useCase,
          classifier,
          configuration,
        ),
    },
    PendingReferenceScheduler,
    {
      provide: IntegrationEventPublisher,
      inject: [SNS_CLIENT, applicationConfiguration.KEY],
      useFactory: (
        snsClient: SNSClient,
        configuration: ApplicationConfiguration,
      ) => new SnsIntegrationEventPublisher(
        snsClient,
        configuration.aws.integrationEventsTopicArn,
      ),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [
        WagerProcessingPersistence,
        IntegrationEventPublisher,
        applicationConfiguration.KEY,
      ],
      useFactory: (
        persistence: WagerProcessingPersistence,
        publisher: IntegrationEventPublisher,
        configuration: ApplicationConfiguration,
      ) => new OutboxPublisherWorker(persistence, publisher, {
        enabled: configuration.workers.outboxPublisherEnabled,
        batchSize: configuration.workers.outboxBatchSize,
        pollIntervalMs: configuration.workers.outboxPollIntervalMs,
        retryBaseMs: configuration.workers.outboxRetryBaseMs,
        retryMaxMs: configuration.workers.outboxRetryMaxMs,
      }),
    },
  ],
  exports: [
    ProcessWagerTransactionUseCase,
    ProcessWagerSqsMessageUseCase,
    PendingReferenceWorker,
    WagerTransactionSqsConsumer,
    OutboxPublisherWorker,
  ],
})
export class WageringModule {}
