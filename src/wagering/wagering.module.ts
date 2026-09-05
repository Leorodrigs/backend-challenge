import { Module } from '@nestjs/common';

import { PersistenceModule } from '../persistence/mikro-orm/persistence.module.js';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case.js';
import { WagerProcessingPersistence } from './application/wager-processing.persistence.js';
import { applicationConfiguration, type ApplicationConfiguration } from '../config/application.config.js';
import { ClaimedWagerTransactionProcessor } from './application/claimed-wager-transaction.processor.js';
import { PendingReferenceRetryPolicy } from './application/pending-reference-retry-policy.js';
import { PendingReferenceWorker } from './application/pending-reference.worker.js';
import { PendingReferenceScheduler } from './pending-reference.scheduler.js';

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: ClaimedWagerTransactionProcessor,
      inject: [applicationConfiguration.KEY],
      useFactory: ({ workers }: ApplicationConfiguration) => new ClaimedWagerTransactionProcessor(
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
      useFactory: (persistence: WagerProcessingPersistence, processor: ClaimedWagerTransactionProcessor) =>
        new ProcessWagerTransactionUseCase(persistence, processor),
    },
    {
      provide: PendingReferenceWorker,
      inject: [WagerProcessingPersistence, ClaimedWagerTransactionProcessor],
      useFactory: (persistence: WagerProcessingPersistence, processor: ClaimedWagerTransactionProcessor) =>
        new PendingReferenceWorker(persistence, processor),
    },
    PendingReferenceScheduler,
  ],
  exports: [ProcessWagerTransactionUseCase, PendingReferenceWorker],
})
export class WageringModule {}
