import { Logger } from '@nestjs/common';

import type { ApplicationMetrics } from '../../observability/application-metrics.js';
import type { Money } from '../../shared/domain/value-objects/money.js';
import { ReconciliationWalletNotFoundError } from './wallet-reconciliation.errors.js';
import type { WalletReconciliationPersistence } from './wallet-reconciliation.persistence.js';

export interface WalletReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconciliationLogger {
  log(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly persistence: WalletReconciliationPersistence,
    private readonly metrics?: ApplicationMetrics,
    private readonly logger: ReconciliationLogger = new Logger(
      ReconcileWalletUseCase.name,
    ),
  ) {}

  async execute(walletId: string): Promise<WalletReconciliationResult> {
    const startedAt = performance.now();

    try {
      const snapshot = await this.persistence.readSnapshot(walletId);
      if (snapshot === undefined) {
        throw new ReconciliationWalletNotFoundError(walletId);
      }

      // Signed diagnostic: a positive value means the stored balance is higher.
      const difference = snapshot.storedBalance.subtract(
        snapshot.calculatedBalance,
      );
      const consistent = snapshot.storedBalance.equals(
        snapshot.calculatedBalance,
      );
      const result = {
        ...snapshot,
        difference,
        consistent,
      };

      this.metrics?.recordReconciliation(
        consistent ? 'consistent' : 'divergent',
      );
      this.metrics?.recordProcessingDuration(
        'reconciliation',
        consistent ? 'processed' : 'error',
        (performance.now() - startedAt) / 1_000,
      );

      const fields = {
        walletId,
        checkedEntries: snapshot.checkedEntries,
        consistent,
        outcome: consistent
          ? 'RECONCILIATION_CONSISTENT'
          : 'RECONCILIATION_DIVERGENCE',
      };
      try {
        if (consistent) this.logger.log(fields);
        else this.logger.warn(fields);
      } catch {
        // The read-only diagnostic result must not depend on logger availability.
      }

      return result;
    } catch (error: unknown) {
      this.metrics?.recordProcessingDuration(
        'reconciliation',
        'error',
        (performance.now() - startedAt) / 1_000,
      );
      throw error;
    }
  }
}
