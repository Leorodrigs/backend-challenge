import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import { ApplicationMetrics } from '../../src/observability/application-metrics.js';
import { MikroOrmMetricsStatePersistence } from '../../src/persistence/mikro-orm/mikro-orm-metrics-state.persistence.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { MikroOrmWalletReconciliationPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wallet-reconciliation.persistence.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../src/wagering/application/wager-processing.persistence.js';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { ReconcileWalletUseCase } from '../../src/wallet/reconciliation/reconcile-wallet.use-case.js';
import {
  createWagerProcessingDatabase,
  type WagerProcessingDatabase,
} from '../helpers/wager-processing-database.js';
import { seedWallet, wagerInput } from '../helpers/wager-processing-fixtures.js';

const shouldRun = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!shouldRun)('reconciliation snapshot and lock observability', () => {
  let database: WagerProcessingDatabase;
  let queries: string[];

  beforeAll(async () => {
    queries = [];
    database = await createWagerProcessingDatabase((query) => {
      queries.push(query);
    });
  }, 15_000);

  afterAll(async () => {
    await database?.close();
  }, 15_000);

  test('an uncommitted BET is never observed as a wallet/ledger mismatch', async () => {
    const wallet = await seedWallet(database, '100.00');
    const base = new MikroOrmWagerProcessingPersistence(database.orm.em);
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held: WagerProcessingPersistence = {
      transactional: <T>(work: (context: WagerProcessingContext) => Promise<T>) =>
        base.transactional((context) =>
          work({
            ...context,
            wallets: {
              save: (candidate) => context.wallets.save(candidate),
              findByIdForUpdate: async (id) => {
                const locked = await context.wallets.findByIdForUpdate(id);
                acquired.resolve();
                await release.promise;
                return locked;
              },
            },
          }),
        ),
    };
    const processing = new ProcessWagerTransactionUseCase(
      held,
      undefined,
      undefined,
      { log: mock(() => {}) },
    );
    const reconciliation = new ReconcileWalletUseCase(
      new MikroOrmWalletReconciliationPersistence(database.orm.em),
      new ApplicationMetrics(),
      { log: mock(() => {}), warn: mock(() => {}) },
    );
    const bet = processing.execute(
      wagerInput(wallet, WagerTransactionKind.Bet, '25.00'),
    );
    await acquired.promise;

    const during = await reconciliation.execute(wallet.id);
    expect(during.consistent).toBe(true);
    expect(during.storedBalance.toJSON().amount).toBe('100.00');
    expect(during.calculatedBalance.toJSON().amount).toBe('100.00');
    expect(during.checkedEntries).toBe(1);

    release.resolve();
    await bet;
    const after = await reconciliation.execute(wallet.id);
    expect(after.consistent).toBe(true);
    expect(after.storedBalance.toJSON().amount).toBe('75.00');
    expect(after.calculatedBalance.toJSON().amount).toBe('75.00');
    expect(after.checkedEntries).toBe(2);
    expect(
      queries.some((query) => /isolation level repeatable read/i.test(query)),
    ).toBe(true);
    expect(
      queries.some(
        (query) =>
          /from wallets/i.test(query) && !/for[\s\S]*update/i.test(query),
      ),
    ).toBe(true);
  }, 15_000);

  test('counts a real PostgreSQL waiter on a wallet FOR UPDATE lock', async () => {
    const wallet = await seedWallet(database, '100.00');
    const blocker = await database.pool.connect();
    const waiter = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select * from wallets where id = $1 for update', [
        wallet.id,
      ]);
      await waiter.query('begin');
      const waitingQuery = waiter.query(
        'select * from wallets where id = $1 for update',
        [wallet.id],
      );

      const persistence = new MikroOrmMetricsStatePersistence(database.orm.em);
      let observed = 0;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        observed = (await persistence.collect()).walletLockWaiters;
        if (observed >= 1) break;
        await Bun.sleep(10);
      }
      expect(observed).toBeGreaterThanOrEqual(1);

      await blocker.query('commit');
      await waitingQuery;
      await waiter.query('commit');
      expect((await persistence.collect()).walletLockWaiters).toBe(0);
    } finally {
      await blocker.query('rollback').catch(() => {});
      await waiter.query('rollback').catch(() => {});
      blocker.release();
      waiter.release();
    }
  }, 15_000);
});
