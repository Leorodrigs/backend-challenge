import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../../config/application.config.js';
import { createMikroOrmOptions } from './mikro-orm.options.js';

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
})
export class PersistenceModule {}
