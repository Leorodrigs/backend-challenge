import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { parse } from 'dotenv';
import { command, compose, dockerExecutable, endpoints, eventually } from './docker.js';

const full = process.argv.includes('--full');
const testNamePattern = process.argv.find((argument) => argument.startsWith('--test-name-pattern='))?.slice('--test-name-pattern='.length);
const defaults = parse(await Bun.file('.env.example').text());
const project = `wager-final-${Date.now()}-${randomUUID().slice(0, 6)}`;
const postgresPublishedPort = await availablePort();
process.env.POSTGRES_PUBLISHED_PORT = String(postgresPublishedPort);
const results: { command: string; status: string; elapsedMs: number }[] = [];
await mkdir('test-results', { recursive: true });
const log = setInterval(() => console.log(`[final] ${project}: validation running`), 30000);
// A foreground WSL client keeps the distro alive while host-side tests access
// published container ports without invoking wsl.exe for several minutes.
const wslKeeper = dockerExecutable[0] === 'wsl.exe'
  ? Bun.spawn(['wsl.exe', '--exec', 'sleep', '7200'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  : undefined;
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve PostgreSQL test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function check(args: string[], env: Record<string, string | undefined> = {}) {
  const start = Date.now();
  try {
    await command(args, { env, outputFile: `test-results/${project}-command-${results.length + 1}.log` });
    results.push({ command: args.join(' '), status: 'PASS', elapsedMs: Date.now() - start });
  }
  catch (error) { results.push({ command: args.join(' '), status: 'FAIL', elapsedMs: Date.now() - start }); throw error; }
}
let passed = false;
try {
  if (full) {
    await check([process.execPath, 'install', '--frozen-lockfile']);
    await check([process.execPath, 'run', 'build']);
    await check([process.execPath, 'scripts/check-runtime.mjs']);
    await check([process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']);
    await check([process.execPath, 'run', 'test:unit']);
    await check([process.execPath, 'run', 'test'], { RUN_INTEGRATION_TESTS: 'false', RUN_DISTRIBUTED_TESTS: 'false' });
    await check([process.execPath, 'scripts/audit-static.ts']);
  }
  await compose(project, ['--profile', 'fixtures', 'build', ...(full ? ['--no-cache'] : []), 'app-a', 'fixture', 'localstack']);
  await compose(project, ['up', '-d', '--wait', 'postgres', 'localstack']);
  await compose(project, ['run', '--rm', 'migrate']);
  const pgPort = (await compose(project, ['port', 'postgres', '5432'], true)).split(':').at(-1)!;
  const aws = `http://${await compose(project, ['port', 'localstack', '4566'], true)}`;
  const env = { ...defaults, NODE_ENV: 'test', RUN_INTEGRATION_TESTS: 'true', DISTRIBUTED_PROJECT: project,
    DATABASE_HOST: '127.0.0.1', DATABASE_PORT: pgPort, DATABASE_NAME: 'wagering', DATABASE_USER: 'wagering', DATABASE_PASSWORD: 'wagering',
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_ENDPOINT_URL: aws,
    WAGER_QUEUE_URL: `${aws}/queue/us-east-1/000000000000/wager-transactions.fifo`,
    WAGER_DLQ_URL: `${aws}/queue/us-east-1/000000000000/wager-transactions-dlq.fifo`,
    INTEGRATION_EVENTS_TOPIC_ARN: 'arn:aws:sns:us-east-1:000000000000:wager-integration-events',
    SQS_CONSUMER_ENABLED: 'false', OUTBOX_PUBLISHER_ENABLED: 'false', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  if (full) {
    await check([process.execPath, 'run', 'test:integration'], env);
    await check([process.execPath, 'run', 'test:concurrency'], env);
    await check([process.execPath, 'node_modules/@mikro-orm/cli/cli.js', 'migration:check'], env);
    await check([process.execPath, 'node_modules/@mikro-orm/cli/cli.js', 'migration:create', '--dump'], env);
    await check([process.execPath, 'run', 'migration:status'], env);
  }
  await compose(project, ['up', '-d', '--wait', 'app-a', 'app-b', 'app-c']);
  const urls = await endpoints(project);
  await Promise.all(urls.map((url) => eventually(() => fetch(`${url}/health/ready`).then((r) => r.status), (s) => s === 200)));
  console.log(JSON.stringify({ project, urls, postgresPort: pgPort, aws }));
  await Bun.write(`test-results/${project}-environment.json`, JSON.stringify({ project, urls, postgresPort: pgPort, aws,
    containers: await compose(project, ['ps', '--format', 'json'], true) }, null, 2));
  await check([process.execPath, 'scripts/smoke-api.ts', urls[0]!], env);
  await check([process.execPath, 'test', 'test/distributed', '--timeout', '180000', '--max-concurrency=1',
    ...(testNamePattern ? ['--test-name-pattern', testNamePattern] : [])], {
    ...env, DISTRIBUTED_URLS: JSON.stringify(urls), RUN_DISTRIBUTED_TESTS: 'true',
  });
  await check(['git', 'diff', '--check']);
  passed = true;
} catch (error) {
  console.error(error);
  await Bun.write(`test-results/${project}-containers.log`, await compose(project, ['ps', '-a'], true).catch(String));
  await Bun.write(`test-results/${project}-services.log`, await compose(project, ['logs', '--no-color', '--tail', '300'], true).catch(String));
} finally {
  await compose(project, ['--profile', 'fixtures', 'down', '--volumes', '--remove-orphans']).catch((error) => { passed = false; console.error(error); });
  wslKeeper?.kill();
  await wslKeeper?.exited.catch(() => undefined);
  clearInterval(log);
  await Bun.write(`test-results/${project}-results.json`, JSON.stringify({ project, passed, results }, null, 2));
  process.exitCode = passed ? 0 : 1;
}
