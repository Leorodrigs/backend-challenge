import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';

import type { ApplicationConfiguration } from '../../config/application.config.js';

export function createMikroOrmOptions(
  configuration: ApplicationConfiguration,
): Options {
  return defineConfig({
    host: configuration.database.host,
    port: configuration.database.port,
    dbName: configuration.database.name,
    user: configuration.database.user,
    password: configuration.database.password,
    pool: { min: 0, max: 20 },
    driverOptions: { connectionTimeoutMillis: 2000 },
    entities: ['dist/**/*.entity.js'],
    entitiesTs: ['src/**/*.entity.ts'],
    // Bun supports TS even when executing dist/*.js. Select the files that
    // actually ship with this entrypoint, rather than Bun's TS capability.
    preferTs: import.meta.url.endsWith('.ts'),
    discovery: {
      warnWhenNoEntities: false,
    },
    extensions: [Migrator],
    migrations: {
      // CLI check/dump must compare with the actual database, not a stale local snapshot.
      snapshot: false,
      path: 'dist/persistence/mikro-orm/migrations',
      pathTs: 'src/persistence/mikro-orm/migrations',
      glob: '!(*.d).{js,ts}',
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: false,
      emit: 'ts',
    },
    debug: false,
  });
}
