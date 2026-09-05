import { Module } from '@nestjs/common';

import { PersistenceModule } from '../persistence/mikro-orm/persistence.module.js';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case.js';
import { WagerProcessingPersistence } from './application/wager-processing.persistence.js';

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [WagerProcessingPersistence],
      useFactory: (persistence: WagerProcessingPersistence) =>
        new ProcessWagerTransactionUseCase(persistence),
    },
  ],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
