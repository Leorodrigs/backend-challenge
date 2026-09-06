import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../../config/application.config.js';
import { WagerProcessingPersistence } from '../../wagering/application/wager-processing.persistence.js';
import { createMikroOrmOptions } from './mikro-orm.options.js';
import { MikroOrmWagerProcessingPersistence } from './mikro-orm-wager-processing.persistence.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerEntryRepository } from './repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';
import { MikroOrmInboxMessageRepository } from './repositories/mikro-orm-inbox-message.repository.js';
import { MikroOrmOutboxMessageRepository } from './repositories/mikro-orm-outbox-message.repository.js';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [ConfigModule],
      inject: [applicationConfiguration.KEY],
      useFactory: (configuration: ApplicationConfiguration) =>
        createMikroOrmOptions(configuration),
    }),
  ],
  providers: [
    {
      provide: WagerProcessingPersistence,
      useClass: MikroOrmWagerProcessingPersistence,
    },
    MikroOrmWalletRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmWalletLedgerEntryRepository,
    MikroOrmInboxMessageRepository,
    MikroOrmOutboxMessageRepository,
  ],
  exports: [
    WagerProcessingPersistence,
    MikroOrmWalletRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmWalletLedgerEntryRepository,
    MikroOrmInboxMessageRepository,
    MikroOrmOutboxMessageRepository,
  ],
})
export class PersistenceModule {}
