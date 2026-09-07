import { Module } from '@nestjs/common';

import { ApplicationMetrics } from '../../observability/application-metrics.js';
import { PersistenceModule } from '../../persistence/mikro-orm/persistence.module.js';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { WalletReconciliationPersistence } from './wallet-reconciliation.persistence.js';

@Module({
  imports: [PersistenceModule],
  controllers: [ReconciliationController],
  providers: [
    {
      provide: ReconcileWalletUseCase,
      inject: [WalletReconciliationPersistence, ApplicationMetrics],
      useFactory: (
        persistence: WalletReconciliationPersistence,
        metrics: ApplicationMetrics,
      ) => new ReconcileWalletUseCase(persistence, metrics),
    },
  ],
})
export class ReconciliationModule {}
