import { describe, expect, mock, test } from 'bun:test';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import type { HealthIndicatorService } from '@nestjs/terminus';

import type { ApplicationConfiguration } from '../../../src/config/application.config.js';
import { PostgresHealthIndicator } from '../../../src/health/postgres.health-indicator.js';
import { SqsHealthIndicator } from '../../../src/health/sqs.health-indicator.js';

function indicatorService(): HealthIndicatorService {
  return {
    check: (key: string) => ({
      up: () => ({ [key]: { status: 'up' } }),
      down: (details: Record<string, unknown>) => ({
        [key]: { status: 'down', ...details },
      }),
    }),
  } as unknown as HealthIndicatorService;
}

const configuration = {
  aws: { wagerQueueUrl: 'http://localhost/source' },
} as ApplicationConfiguration;

describe('readiness health indicators', () => {
  test('PostgreSQL readiness executes SELECT 1 and reports controlled failure', async () => {
    const execute = mock(async (_sql: string) => {
      throw new Error('database unavailable');
    });
    const orm = {
      em: { getConnection: () => ({ execute }) },
    } as unknown as MikroORM;
    const indicator = new PostgresHealthIndicator(orm, indicatorService());

    expect(await indicator.check()).toEqual({
      postgres: { status: 'down', message: 'PostgreSQL check failed' },
    });
    expect(execute).toHaveBeenCalledWith('select 1');
  });

  test('SQS readiness calls GetQueueAttributes on the main queue and reports failure', async () => {
    const send = mock(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetQueueAttributesCommand);
      expect((command as GetQueueAttributesCommand).input.QueueUrl).toBe(
        configuration.aws.wagerQueueUrl,
      );
      throw new Error('SQS unavailable');
    });
    const indicator = new SqsHealthIndicator(
      { send } as unknown as SQSClient,
      configuration,
      indicatorService(),
    );

    expect(await indicator.check()).toEqual({
      sqs: { status: 'down', message: 'SQS check failed' },
    });
  });
});
