import { ClaimedWagerTransactionProcessor } from './claimed-wager-transaction.processor.js';
import type { ProcessWagerTransactionResult } from './process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from './wager-processing.persistence.js';

export class PendingReferenceWorker {
  private running = false;

  constructor(
    private readonly persistence: WagerProcessingPersistence,
    private readonly processor = new ClaimedWagerTransactionProcessor(),
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
        const result = await this.persistence.transactional(async (context) => {
          const pending = await context.transactions.claimNextPendingReference(now ?? new Date());
          if (pending === undefined) return undefined;
          return this.processor.process(context, pending.transaction, pending, now);
        });
        if (result === undefined) break;
        results.push(result);
      }
      return results;
    } finally {
      this.running = false;
    }
  }
}
