import { MikroORM } from '@mikro-orm/postgresql';
import { parse } from 'dotenv';
import { parseEnvironment } from '../dist/config/application.config.js';
import { createMikroOrmOptions } from '../dist/persistence/mikro-orm/mikro-orm.options.js';

const example = parse(await Bun.file(new URL('../.env.example', import.meta.url)).text());
const options = createMikroOrmOptions(parseEnvironment({ ...example, NODE_ENV: 'test' }));
if (options.preferTs !== false) throw new Error('Compiled runtime must discover compiled entities and migrations');
const orm = await MikroORM.init({ ...options, connect: false });
try {
  const entities = [...orm.getMetadata().getAll().values()].map((metadata) => metadata.className).sort();
  const expected = ['InboxMessageEntity', 'OutboxMessageEntity', 'WagerTransactionEntity', 'WalletEntity', 'WalletLedgerEntryEntity'].sort();
  if (JSON.stringify(entities) !== JSON.stringify(expected)) throw new Error(`Incomplete runtime discovery: ${entities}`);
  const migrations = [];
  for await (const file of new Bun.Glob('Migration*.js').scan(options.migrations.path)) migrations.push(file);
  if (migrations.length !== 7) throw new Error(`Expected seven compiled migrations, found ${migrations.length}`);
  console.log(JSON.stringify({ status: 'PASS', connect: false, entities, compiledMigrations: migrations.length }));
} finally { await orm.close(true); }
