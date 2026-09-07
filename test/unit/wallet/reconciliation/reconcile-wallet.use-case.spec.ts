import { describe, expect, mock, test } from 'bun:test';

import { ApplicationMetrics } from '../../../../src/observability/application-metrics.js';
import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import {
  ReconcileWalletUseCase,
  type ReconciliationLogger,
} from '../../../../src/wallet/reconciliation/reconcile-wallet.use-case.js';
import { ReconciliationWalletNotFoundError } from '../../../../src/wallet/reconciliation/wallet-reconciliation.errors.js';
import type { WalletReconciliationPersistence } from '../../../../src/wallet/reconciliation/wallet-reconciliation.persistence.js';

function money(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function setup(stored: string, calculated: string, checkedEntries = 3) {
  const metrics = new ApplicationMetrics();
  const log = mock((_fields: Record<string, unknown>) => {});
  const warn = mock((_fields: Record<string, unknown>) => {});
  const logger = { log, warn } satisfies ReconciliationLogger;
  const persistence: WalletReconciliationPersistence = {
    readSnapshot: mock(async () => ({
      walletId: 'wallet-1',
      storedBalance: money(stored),
      calculatedBalance: money(calculated),
      checkedEntries,
    })),
  };
  return {
    metrics,
    log,
    warn,
    persistence,
    useCase: new ReconcileWalletUseCase(persistence, metrics, logger),
  };
}

describe('ReconcileWalletUseCase', () => {
  test('returns the exact consistent diagnostic and records one INFO result', async () => {
    const state = setup('975.00', '975.00', 42);

    const result = await state.useCase.execute('wallet-1');

    expect(result.walletId).toBe('wallet-1');
    expect(result.storedBalance.toJSON().amount).toBe('975.00');
    expect(result.calculatedBalance.toJSON().amount).toBe('975.00');
    expect(result.difference.toJSON().amount).toBe('0.00');
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(42);
    expect(state.log).toHaveBeenCalledTimes(1);
    expect(state.warn).not.toHaveBeenCalled();
    expect(await state.metrics.metrics()).toContain(
      'wager_reconciliation_total{result="consistent"} 1',
    );
  });

  test.each([
    ['100.00', '75.00', '25.00'],
    ['75.00', '100.00', '-25.00'],
  ])(
    'defines signed difference as stored minus calculated (%s - %s)',
    async (stored, calculated, expected) => {
      const state = setup(stored, calculated);

      const result = await state.useCase.execute('wallet-1');

      expect(result.difference.toJSON().amount).toBe(expected);
      expect(result.consistent).toBe(false);
      expect(state.warn).toHaveBeenCalledTimes(1);
      expect(state.warn.mock.calls[0]?.[0]).toEqual({
        walletId: 'wallet-1',
        checkedEntries: 3,
        consistent: false,
        outcome: 'RECONCILIATION_DIVERGENCE',
      });
      const serializedLog = JSON.stringify(state.warn.mock.calls[0]?.[0]);
      expect(serializedLog).not.toMatch(
        /amount|storedBalance|calculatedBalance|difference|balanceBefore|balanceAfter|money|payload/i,
      );
      expect(await state.metrics.metrics()).toContain(
        'wager_reconciliation_total{result="divergent"} 1',
      );
    },
  );

  test('uses an explicit application error when the wallet does not exist', async () => {
    const persistence: WalletReconciliationPersistence = {
      readSnapshot: async () => undefined,
    };
    const useCase = new ReconcileWalletUseCase(persistence);

    await expect(useCase.execute('missing')).rejects.toBeInstanceOf(
      ReconciliationWalletNotFoundError,
    );
  });

  test('does not let a logger failure replace a completed diagnostic', async () => {
    const state = setup('10.00', '10.00');
    state.log.mockImplementation(() => {
      throw new Error('logger unavailable');
    });

    expect((await state.useCase.execute('wallet-1')).consistent).toBe(true);
  });
});
