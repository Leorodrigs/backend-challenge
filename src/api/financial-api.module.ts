import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PersistenceModule } from '../persistence/mikro-orm/persistence.module.js';
import { WageringModule } from '../wagering/wagering.module.js';
import { WagerProcessingPersistence } from '../wagering/application/wager-processing.persistence.js';
import { CreateWalletUseCase } from '../wallet/application/create-wallet.use-case.js';
import { MikroOrmFinancialQueryAdapter } from '../persistence/mikro-orm/mikro-orm-financial-query.adapter.js';
import { FinancialQueryPort } from './financial-query.port.js';
import { FinancialController } from './financial.controller.js';
import { FinancialExceptionFilter } from './financial-exception.filter.js';
import { ProviderIdentityGuard } from './provider-identity.guard.js';

@Module({ imports: [PersistenceModule, WageringModule], controllers: [FinancialController], providers: [
  ProviderIdentityGuard,
  { provide: APP_FILTER, useClass: FinancialExceptionFilter },
  { provide: FinancialQueryPort, useClass: MikroOrmFinancialQueryAdapter },
  { provide: CreateWalletUseCase, inject: [WagerProcessingPersistence],
    useFactory: (persistence: WagerProcessingPersistence) => new CreateWalletUseCase(persistence) },
] })
export class FinancialApiModule {}
