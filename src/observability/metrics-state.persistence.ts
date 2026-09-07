import type { WagerTransactionMetricStatus } from './application-metrics.js';

export interface PersistedMetricsState {
  transactionsByStatus: Readonly<
    Partial<Record<WagerTransactionMetricStatus, number>>
  >;
  walletLockWaiters: number;
  outboxLagSeconds: number;
  outboxPendingMessages: number;
}

export abstract class MetricsStatePersistence {
  abstract collect(): Promise<PersistedMetricsState>;
}
