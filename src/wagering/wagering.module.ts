import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../config/application.config.js';
import { SQS_CLIENT } from '../messaging/aws/aws.constants.js';
import { AwsModule } from '../messaging/aws/aws.module.js';
import { MessageFailureClassifier } from '../messaging/sqs/message-failure.classifier.js';
import { ProcessWagerSqsMessageUseCase } from '../messaging/sqs/process-wager-sqs-message.use-case.js';
import { WagerTransactionSqsConsumer } from '../messaging/sqs/wager-transaction-sqs.consumer.js';
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
  ],
  exports: [
    ProcessWagerTransactionUseCase,
    ProcessWagerSqsMessageUseCase,
    PendingReferenceWorker,
    WagerTransactionSqsConsumer,
  ],
})
export class WageringModule {}
