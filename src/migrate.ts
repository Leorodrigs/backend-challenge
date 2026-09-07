import 'reflect-metadata';
import 'dotenv/config';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadApplicationConfiguration } from './config/application.config.js';
import { createMikroOrmOptions } from './persistence/mikro-orm/mikro-orm.options.js';

const orm = await MikroORM.init(createMikroOrmOptions(loadApplicationConfiguration()));
try { await orm.migrator.up(); }
finally { await orm.close(true); }
