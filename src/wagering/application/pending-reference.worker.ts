import { ClaimedWagerTransactionProcessor } from './claimed-wager-transaction.processor.js';
import type { ProcessWagerTransactionResult } from './process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from './wager-processing.persistence.js';

export class PendingReferenceWorker {
  private running = false;

  constructor(
    private readonly persistence: WagerProcessingPersistence,
    private readonly processor = new ClaimedWagerTransactionProcessor(),
    private readonly metrics?: ApplicationMetrics,
    private readonly logger: Pick<Logger, 'log'> = new Logger(
      PendingReferenceWorker.name,
    ),
  ) {}

  async runOnce(now?: Date, batchSize = 20): Promise<ProcessWagerTransactionResult[]> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError('Pending reference batchSize must be between 1 and 1000');
    }
    // Local overlap suppression only. PostgreSQL owns the distributed guarantee.
    if (this.running) return [];
    this.running = true;
    try {
      const results: ProcessWagerTransactionResult[] = [];
      for (let i = 0; i < batchSize; i++) {
        const startedAt = performance.now();
        const committed = await this.persistence.transactional(async (context) => {
          const pending = await context.transactions.claimNextPendingReference(now ?? new Date());
          if (pending === undefined) return undefined;
          const result = await this.processor.process(
            context,
            pending.transaction,
            pending,
            now,
          );
          return {
            result,
            transactionId: pending.transaction.id,
            walletId: pending.transaction.walletId,
            providerId: pending.transaction.providerId,
            attemptCount:
              pending.retryState.attemptCount +
              (result.status === WagerTransactionStatus.PendingReference ? 1 : 0),
          };
        });
        if (committed === undefined) break;
        const outcome = this.metricOutcome(committed.result);
        if (committed.result.status === WagerTransactionStatus.PendingReference) {
          this.metrics?.recordRetry('pending_reference');
        }
        this.metrics?.recordProcessingDuration(
          'pending_reference',
          outcome,
          (performance.now() - startedAt) / 1_000,
        );
        try {
          this.logger.log({
            correlationId: committed.transactionId,
            transactionId: committed.transactionId,
            walletId: committed.walletId,
            providerId: committed.providerId,
            status: committed.result.status,
            attemptCount: committed.attemptCount,
            outcome,
          });
        } catch {
          // Logging is best effort and happens after the retry transaction commits.
        }
        results.push(committed.result);
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  private metricOutcome(result: ProcessWagerTransactionResult): ProcessingOutcome {
    if (result.status === WagerTransactionStatus.Processed) return 'processed';
    if (result.status === WagerTransactionStatus.Rejected) return 'rejected';
    if (result.status === WagerTransactionStatus.PendingReference) {
      return 'pending_reference';
    }
    return 'error';
  }
}
import { Logger } from '@nestjs/common';

import type {
  ApplicationMetrics,
  ProcessingOutcome,
} from '../../observability/application-metrics.js';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.js';
