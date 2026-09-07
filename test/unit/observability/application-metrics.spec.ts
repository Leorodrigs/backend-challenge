import { describe, expect, test } from 'bun:test';

import { ApplicationMetrics } from '../../../src/observability/application-metrics.js';

describe('ApplicationMetrics', () => {
  test('uses a dedicated registry for every application context', async () => {
    const first = new ApplicationMetrics();
    const second = new ApplicationMetrics();

    first.recordDuplicate('business');
    second.recordDuplicate('inbox');

    expect(await first.metrics()).toContain(
      'wager_duplicates_total{type="business"} 1',
    );
    expect(await first.metrics()).not.toContain('type="inbox"');
    expect(await second.metrics()).toContain(
      'wager_duplicates_total{type="inbox"} 1',
    );
    expect(await second.metrics()).not.toContain('type="business"');
  });

  test('exposes the bounded counters, gauges and latency histogram', async () => {
    const metrics = new ApplicationMetrics();
    metrics.recordDuplicate('business');
    metrics.recordDuplicate('inbox');
    metrics.recordRetry('sqs');
    metrics.recordRetry('outbox');
    metrics.recordRetry('pending_reference');
    metrics.recordDlqMove('permanent');
    metrics.recordDlqMove('exhausted');
    metrics.recordProcessingDuration('direct', 'processed', 0.01);
    metrics.recordReconciliation('consistent');
    metrics.recordReconciliation('divergent');
    metrics.updateObservableState({
      transactionsByStatus: {
        PROCESSED: 2,
        REJECTED: 1,
        PENDING_REFERENCE: 3,
      },
      dlqMessagesVisible: 4,
      walletLockWaiters: 1,
      outboxLagSeconds: 12.5,
      outboxPendingMessages: 6,
    });

    const body = await metrics.metrics();

    expect(metrics.contentType).toContain('text/plain');
    expect(body).toContain('wager_transactions_current{status="PROCESSED"} 2');
    expect(body).toContain('wager_transactions_current{status="PENDING"} 0');
    expect(body).toContain('wager_dlq_messages_visible 4');
    expect(body).toContain('wager_wallet_lock_waiters 1');
    expect(body).toContain('wager_outbox_lag_seconds 12.5');
    expect(body).toContain('wager_outbox_pending_messages 6');
    expect(body).toContain(
      'wager_processing_duration_seconds_count{source="direct",outcome="processed"} 1',
    );
    expect(body).toContain('wager_reconciliation_total{result="consistent"} 1');
    expect(body).toContain('wager_reconciliation_total{result="divergent"} 1');
    expect(body).not.toMatch(
      /walletId=|transactionId=|messageId=|providerId=|idempotencyKey=|correlationId=/,
    );
  });
});
