import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Pool } from 'pg';

import { parseEnvironment } from '../../src/config/application.config.js';
import { WalletEntity } from '../../src/persistence/mikro-orm/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../src/persistence/mikro-orm/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../src/persistence/mikro-orm/entities/wallet-ledger-entry.entity.js';
import { createMikroOrmOptions } from '../../src/persistence/mikro-orm/mikro-orm.options.js';

export interface WagerProcessingDatabase {
  orm: MikroORM;
  pool: Pool;
  close(): Promise<void>;
}

export async function createWagerProcessingDatabase(
  logger: (message: string) => void = () => {},
): Promise<WagerProcessingDatabase> {
  const configuration = parseEnvironment(process.env);
  const name = `wagering_stage4_${randomUUID().replaceAll('-', '')}`;
  const assertDisposableName = (): void => {
    if (!/^wagering_stage4_[a-f0-9]{32}$/.test(name)) {
      throw new Error('Refusing to create or drop an unexpected test database');
    }
  };
  assertDisposableName();

  const connection = {
    host: configuration.database.host,
    port: configuration.database.port,
    user: configuration.database.user,
    password: configuration.database.password,
    connectionTimeoutMillis: 3_000,
  };
  const maintenance = new Pool({ ...connection, database: 'postgres' });
  let created = false;
  let pool: Pool | undefined;
  let orm: MikroORM | undefined;

  async function close(): Promise<void> {
    try {
      try {
        await orm?.close(true);
      } finally {
        await pool?.end();
      }
    } finally {
      try {
        if (created) {
          assertDisposableName();
          await maintenance.query(`drop database if exists "${name}" with (force)`);
          created = false;
        }
      } finally {
        await maintenance.end();
      }
    }
  }

  try {
    await maintenance.query(`create database "${name}"`);
    created = true;
    pool = new Pool({ ...connection, database: name, statement_timeout: 10_000 });
    const options = createMikroOrmOptions({
      ...configuration,
      database: { ...configuration.database, name },
    });
    orm = await MikroORM.init({
      ...options,
      entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity],
      entitiesTs: [],
      migrations: { ...options.migrations, snapshot: false },
      debug: ['query'],
      logger,
    });
    await orm.migrator.up();
    return { orm, pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
