import { describe, expect, mock, test } from 'bun:test';
import type { HealthCheckService } from '@nestjs/terminus';

import { HealthController } from '../../../src/health/health.controller.js';
import type { LivenessHealthIndicator } from '../../../src/health/liveness.health-indicator.js';
import type { PostgresHealthIndicator } from '../../../src/health/postgres.health-indicator.js';
import type { SqsHealthIndicator } from '../../../src/health/sqs.health-indicator.js';

function healthService(): HealthCheckService {
  return {
    check: async (checks: Array<() => unknown>) => {
      const details = Object.assign(
        {},
        ...(await Promise.all(checks.map((check) => check()))),
      );
      return { status: 'ok', info: details, error: {}, details };
    },
  } as unknown as HealthCheckService;
}

describe('HealthController', () => {
  test('liveness never invokes PostgreSQL or SQS readiness indicators', async () => {
    const postgres = { check: mock(async () => { throw new Error('down'); }) };
    const sqs = { check: mock(async () => { throw new Error('down'); }) };
    const controller = new HealthController(
      healthService(),
      { check: () => ({ application: { status: 'up' } }) } as LivenessHealthIndicator,
      postgres as unknown as PostgresHealthIndicator,
      sqs as unknown as SqsHealthIndicator,
    );

    expect((await controller.live()).status).toBe('ok');
    expect(postgres.check).not.toHaveBeenCalled();
    expect(sqs.check).not.toHaveBeenCalled();
  });

  test('readiness invokes exactly PostgreSQL and the main SQS queue', async () => {
    const postgres = { check: mock(async () => ({ postgres: { status: 'up' } })) };
    const sqs = { check: mock(async () => ({ sqs: { status: 'up' } })) };
    const controller = new HealthController(
      healthService(),
      { check: () => ({ application: { status: 'up' } }) } as LivenessHealthIndicator,
      postgres as unknown as PostgresHealthIndicator,
      sqs as unknown as SqsHealthIndicator,
    );

    expect((await controller.ready()).status).toBe('ok');
    expect(postgres.check).toHaveBeenCalledTimes(1);
    expect(sqs.check).toHaveBeenCalledTimes(1);
  });
});
