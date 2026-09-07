import type { SNSClient } from '@aws-sdk/client-sns';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';

import { ApplicationMetrics } from '../observability/application-metrics.js';
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
      inject: [
        WagerProcessingPersistence,
        ClaimedWagerTransactionProcessor,
        ApplicationMetrics,
      ],
      useFactory: (
        persistence: WagerProcessingPersistence,
        processor: ClaimedWagerTransactionProcessor,
        metrics: ApplicationMetrics,
      ) => new ProcessWagerTransactionUseCase(persistence, processor, metrics),
    },
    {
      provide: PendingReferenceWorker,
      inject: [
        WagerProcessingPersistence,
        ClaimedWagerTransactionProcessor,
        ApplicationMetrics,
      ],
      useFactory: (
        persistence: WagerProcessingPersistence,
        processor: ClaimedWagerTransactionProcessor,
        metrics: ApplicationMetrics,
      ) => new PendingReferenceWorker(persistence, processor, metrics),
    },
    MessageFailureClassifier,
    {
      provide: ProcessWagerSqsMessageUseCase,
      inject: [
        WagerProcessingPersistence,
        ProcessWagerTransactionUseCase,
        applicationConfiguration.KEY,
        MessageFailureClassifier,
        ApplicationMetrics,
      ],
      useFactory: (
        persistence: WagerProcessingPersistence,
        useCase: ProcessWagerTransactionUseCase,
        configuration: ApplicationConfiguration,
        classifier: MessageFailureClassifier,
        metrics: ApplicationMetrics,
      ) =>
        new ProcessWagerSqsMessageUseCase(
          persistence,
          useCase,
          configuration.aws.sqsConsumerName,
          undefined,
          classifier,
          metrics,
        ),
    },
    {
      provide: WagerTransactionSqsConsumer,
      inject: [
        SQS_CLIENT,
        ProcessWagerSqsMessageUseCase,
        MessageFailureClassifier,
        applicationConfiguration.KEY,
        ApplicationMetrics,
      ],
      useFactory: (
        sqsClient: SQSClient,
        useCase: ProcessWagerSqsMessageUseCase,
        classifier: MessageFailureClassifier,
        configuration: ApplicationConfiguration,
        metrics: ApplicationMetrics,
      ) =>
        new WagerTransactionSqsConsumer(
          sqsClient,
          useCase,
          classifier,
          configuration,
          metrics,
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
        ApplicationMetrics,
      ],
      useFactory: (
        persistence: WagerProcessingPersistence,
        publisher: IntegrationEventPublisher,
        configuration: ApplicationConfiguration,
        metrics: ApplicationMetrics,
      ) => new OutboxPublisherWorker(persistence, publisher, {
        enabled: configuration.workers.outboxPublisherEnabled,
        batchSize: configuration.workers.outboxBatchSize,
        pollIntervalMs: configuration.workers.outboxPollIntervalMs,
        retryBaseMs: configuration.workers.outboxRetryBaseMs,
        retryMaxMs: configuration.workers.outboxRetryMaxMs,
      }, metrics),
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
