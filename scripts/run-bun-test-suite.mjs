import { spawnSync } from 'node:child_process';

const suites = {
  integration: [
    'test/integration/financial-persistence.integration.spec.ts',
    'test/integration/infrastructure.integration.spec.ts',
    'test/integration/outbox-processing.integration.spec.ts',
    'test/integration/outbox-sns.integration.spec.ts',
    'test/integration/sqs-wager-processing.integration.spec.ts',
    'test/integration/wager-idempotency.integration.spec.ts',
    'test/integration/wager-processing.integration.spec.ts',
    'test/integration/wager-reversals.integration.spec.ts',
  ],
  concurrency: [
    'test/concurrency/inbox-processing.concurrency.spec.ts',
    'test/concurrency/outbox-publisher.concurrency.spec.ts',
    'test/concurrency/wager-processing.concurrency.spec.ts',
    'test/concurrency/wager-reversals.concurrency.spec.ts',
  ],
};

const suiteName = process.argv[2];
const files = suites[suiteName];
if (files === undefined) {
  console.error(`Unknown Bun test suite: ${suiteName ?? '<missing>'}`);
  process.exit(2);
}

const bunExecutable = process.execPath;
const maximumNativeAttempts = 3;

for (const file of files) {
  for (let attempt = 1; attempt <= maximumNativeAttempts; attempt += 1) {
    const result = spawnSync(
      bunExecutable,
      ['--smol', 'test', file, '--pass-with-no-tests', '--parallel=1'],
      {
        cwd: process.cwd(),
        env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
        stdio: 'inherit',
      },
    );

    if (result.status === 0) break;

    const nativeRuntimeFailure = result.signal !== null || result.status === 3;
    if (!nativeRuntimeFailure || attempt === maximumNativeAttempts) {
      process.exit(result.status ?? 3);
    }

    console.warn(
      `Bun runtime crashed while running ${file}; retrying isolated process ` +
      `(${attempt + 1}/${maximumNativeAttempts}).`,
    );
  }
}
