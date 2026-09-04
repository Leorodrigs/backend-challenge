import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../../config/application.config.js';
import { createMikroOrmOptions } from './mikro-orm.options.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerEntryRepository } from './repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';

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
    MikroOrmWalletRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmWalletLedgerEntryRepository,
  ],
  exports: [
    MikroOrmWalletRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmWalletLedgerEntryRepository,
  ],
})
export class PersistenceModule {}
