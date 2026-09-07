import { describe, expect, mock, test } from 'bun:test';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type { ApplicationConfiguration } from '../../../src/config/application.config.js';
import { ApplicationMetrics } from '../../../src/observability/application-metrics.js';
import { MetricsCollector } from '../../../src/observability/metrics.collector.js';
import type { MetricsStatePersistence } from '../../../src/observability/metrics-state.persistence.js';

const configuration = {
  aws: { wagerDlqUrl: 'http://localhost/dlq' },
} as ApplicationConfiguration;

describe('MetricsCollector', () => {
  test('refreshes PostgreSQL and real-queue gauges as one scrape operation', async () => {
    const metrics = new ApplicationMetrics();
    const persistence: MetricsStatePersistence = {
      collect: mock(async () => ({
        transactionsByStatus: { PROCESSED: 2 },
        walletLockWaiters: 1,
        outboxLagSeconds: 3.5,
        outboxPendingMessages: 4,
      })),
    };
    const send = mock(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetQueueAttributesCommand);
      return { Attributes: { ApproximateNumberOfMessages: '5' } };
    });
    const collector = new MetricsCollector(
      persistence,
      { send } as unknown as SQSClient,
      configuration,
      metrics,
    );

    await collector.refresh();

    const body = await metrics.metrics();
    expect(body).toContain('wager_dlq_messages_visible 5');
    expect(body).toContain('wager_transactions_current{status="PROCESSED"} 2');
  });

  test('propagates collection failure instead of publishing a false zero', async () => {
    const metrics = new ApplicationMetrics();
    const failure = new Error('PostgreSQL unavailable');
    const send = mock(async () => ({}));
    const collector = new MetricsCollector(
      { collect: async () => { throw failure; } },
      { send } as unknown as SQSClient,
      configuration,
      metrics,
    );

    await expect(collector.refresh()).rejects.toBe(failure);
    expect(send).not.toHaveBeenCalled();
  });

  test('rejects a missing SQS gauge instead of inventing availability', async () => {
    const collector = new MetricsCollector(
      {
        collect: async () => ({
          transactionsByStatus: {},
          walletLockWaiters: 0,
          outboxLagSeconds: 0,
          outboxPendingMessages: 0,
        }),
      },
      { send: mock(async () => ({ Attributes: {} })) } as unknown as SQSClient,
      configuration,
      new ApplicationMetrics(),
    );

    await expect(collector.refresh()).rejects.toThrow(
      'SQS omitted the visible DLQ message count',
    );
  });
});
