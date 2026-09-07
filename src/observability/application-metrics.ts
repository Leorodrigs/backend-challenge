import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const WAGER_TRANSACTION_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;

export type WagerTransactionMetricStatus =
  (typeof WAGER_TRANSACTION_STATUSES)[number];
export type DuplicateType = 'business' | 'inbox';
export type RetryComponent = 'sqs' | 'outbox' | 'pending_reference';
export type DlqMoveReason = 'permanent' | 'exhausted';
export type ProcessingSource =
  | 'direct'
  | 'sqs'
  | 'pending_reference'
  | 'reconciliation';
export type ProcessingOutcome =
  | 'processed'
  | 'rejected'
  | 'pending_reference'
  | 'replay'
  | 'duplicate'
  | 'error';
export type ReconciliationMetricResult = 'consistent' | 'divergent';

export interface ObservableState {
  transactionsByStatus: Readonly<
    Partial<Record<WagerTransactionMetricStatus, number>>
  >;
  dlqMessagesVisible: number;
  walletLockWaiters: number;
  outboxLagSeconds: number;
  outboxPendingMessages: number;
}

@Injectable()
export class ApplicationMetrics {
  readonly registry = new Registry();

  private readonly transactionsCurrent = new Gauge<'status'>({
    name: 'wager_transactions_current',
    help: 'Current persisted wager transactions grouped by status.',
    labelNames: ['status'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter<'type'>({
    name: 'wager_duplicates_total',
    help: 'Committed duplicate processing outcomes.',
    labelNames: ['type'],
    registers: [this.registry],
  });
  private readonly retries = new Counter<'component'>({
    name: 'wager_retries_total',
    help: 'Confirmed retry schedules grouped by component.',
    labelNames: ['component'],
    registers: [this.registry],
  });
  private readonly dlqMessagesVisible = new Gauge({
    name: 'wager_dlq_messages_visible',
    help: 'Messages currently visible in the configured wager DLQ.',
    registers: [this.registry],
  });
  private readonly dlqMoves = new Counter<'reason'>({
    name: 'wager_dlq_moves_total',
    help: 'Messages successfully sent to the wager DLQ.',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly walletLockWaiters = new Gauge({
    name: 'wager_wallet_lock_waiters',
    help: 'PostgreSQL sessions blocked while waiting for wallet row locks.',
    registers: [this.registry],
  });
  private readonly outboxLagSeconds = new Gauge({
    name: 'wager_outbox_lag_seconds',
    help: 'Age in seconds of the oldest unpublished Outbox message.',
    registers: [this.registry],
  });
  private readonly outboxPendingMessages = new Gauge({
    name: 'wager_outbox_pending_messages',
    help: 'Current number of unpublished Outbox messages.',
    registers: [this.registry],
  });
  private readonly processingDuration = new Histogram<
    'source' | 'outcome'
  >({
    name: 'wager_processing_duration_seconds',
    help: 'Application processing latency measured with a monotonic clock.',
    labelNames: ['source', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter<'result'>({
    name: 'wager_reconciliation_total',
    help: 'Completed wallet reconciliations grouped by consistency result.',
    labelNames: ['result'],
    registers: [this.registry],
  });

  get contentType(): string {
    return this.registry.contentType;
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  recordDuplicate(type: DuplicateType): void {
    this.safely(() => this.duplicates.inc({ type }));
  }

  recordRetry(component: RetryComponent): void {
    this.safely(() => this.retries.inc({ component }));
  }

  recordDlqMove(reason: DlqMoveReason): void {
    this.safely(() => this.dlqMoves.inc({ reason }));
  }

  recordProcessingDuration(
    source: ProcessingSource,
    outcome: ProcessingOutcome,
    seconds: number,
  ): void {
    this.safely(() =>
      this.processingDuration.observe(
        { source, outcome },
        Math.max(0, seconds),
      ),
    );
  }

  recordReconciliation(result: ReconciliationMetricResult): void {
    this.safely(() => this.reconciliations.inc({ result }));
  }

  updateObservableState(state: ObservableState): void {
    this.transactionsCurrent.reset();
    for (const status of WAGER_TRANSACTION_STATUSES) {
      this.transactionsCurrent.set(
        { status },
        state.transactionsByStatus[status] ?? 0,
      );
    }
    this.dlqMessagesVisible.set(state.dlqMessagesVisible);
    this.walletLockWaiters.set(state.walletLockWaiters);
    this.outboxLagSeconds.set(state.outboxLagSeconds);
    this.outboxPendingMessages.set(state.outboxPendingMessages);
  }

  private safely(operation: () => void): void {
    try {
      operation();
    } catch {
      // Local observability must never change financial transaction semantics.
    }
  }
}
