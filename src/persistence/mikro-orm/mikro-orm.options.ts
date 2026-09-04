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
    entities: ['dist/**/*.entity.js'],
    entitiesTs: ['src/**/*.entity.ts'],
    discovery: {
      warnWhenNoEntities: false,
    },
    extensions: [Migrator],
    migrations: {
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
