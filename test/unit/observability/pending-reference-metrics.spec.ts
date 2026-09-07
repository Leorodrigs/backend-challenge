import { describe, expect, mock, test } from 'bun:test';

import { ApplicationMetrics } from '../../../src/observability/application-metrics.js';
import { Money } from '../../../src/shared/domain/value-objects/money.js';
import type { ClaimedWagerTransactionProcessor } from '../../../src/wagering/application/claimed-wager-transaction.processor.js';
import { PendingReferenceWorker } from '../../../src/wagering/application/pending-reference.worker.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../../src/wagering/application/wager-processing.persistence.js';
import { WagerTransaction } from '../../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind } from '../../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../src/wagering/domain/wager-transaction-status.js';

describe('PendingReferenceWorker observability', () => {
  test('records a retry and operational IDs only after persistence resolves', async () => {
    const transaction = WagerTransaction.create({
      id: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'key-1',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'missing',
    });
    transaction.markPendingReference();
    const pending = {
      transaction,
      snapshot: {
        balance: Money.from({ amount: '100.00', currency: 'BRL' }),
        walletVersion: 1,
      },
      retryState: {
        attemptCount: 1,
        nextAttemptAt: new Date(),
        deadlineAt: new Date(Date.now() + 10_000),
      },
    };
    let claimed = false;
    const context = {
      transactions: {
        claimNextPendingReference: mock(async () => {
          if (claimed) return undefined;
          claimed = true;
          return pending;
        }),
      },
    } as unknown as WagerProcessingContext;
    const persistence: WagerProcessingPersistence = {
      transactional: async (work) => work(context),
    };
    const processor = {
      process: mock(async () => ({
        transactionId: transaction.id,
        status: WagerTransactionStatus.PendingReference,
        balance: pending.snapshot.balance,
        walletVersion: 1,
        idempotentReplay: false,
      })),
    } as unknown as ClaimedWagerTransactionProcessor;
    const metrics = new ApplicationMetrics();
    const log = mock((_fields: Record<string, unknown>) => {});
    const worker = new PendingReferenceWorker(
      persistence,
      processor,
      metrics,
      { log },
    );

    expect(await worker.runOnce()).toHaveLength(1);

    expect(await metrics.metrics()).toContain(
      'wager_retries_total{component="pending_reference"} 1',
    );
    expect(await metrics.metrics()).toContain(
      'wager_processing_duration_seconds_count{source="pending_reference",outcome="pending_reference"} 1',
    );
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      correlationId: 'transaction-1',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider-1',
      status: WagerTransactionStatus.PendingReference,
      attemptCount: 2,
      outcome: 'pending_reference',
    });
  });
});
