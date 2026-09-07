import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createWagerProcessingDatabase, type WagerProcessingDatabase } from '../helpers/wager-processing-database.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.js';
import { Money } from '../../src/shared/domain/value-objects/money.js';
import type { WagerProcessingPersistence } from '../../src/wagering/application/wager-processing.persistence.js';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('atomic wallet opening and finite SQL money', () => {
  let db: WagerProcessingDatabase;
  let persistence: WagerProcessingPersistence;
  beforeAll(async () => {
    db = await createWagerProcessingDatabase();
    persistence = new MikroOrmWagerProcessingPersistence(db.orm.em);
  });
  afterAll(async () => { await db?.close(); });
  test('opening stages wallet, transaction, ledger and both events before commit; failure rolls all back', async () => {
    const playerId = randomUUID();
    const failing: WagerProcessingPersistence = {
      transactional: (work) => persistence.transactional(async (context) => {
        const staged = { wallets: 0, transactions: 0, ledger: 0, outbox: 0 };
        await work({ ...context,
          wallets: { ...context.wallets,
            findByIdForUpdate: (id) => context.wallets.findByIdForUpdate(id),
            save: async (wallet) => { await context.wallets.save(wallet); staged.wallets++; } },
          transactions: { ...context.transactions,
            tryClaim: (transaction) => context.transactions.tryClaim(transaction),
            findByIdempotencyKey: (key) => context.transactions.findByIdempotencyKey(key),
            findByProviderAndExternalTransactionId: (provider, external) => context.transactions.findByProviderAndExternalTransactionId(provider, external),
            hasProcessedReversal: (reference, kind) => context.transactions.hasProcessedReversal(reference, kind),
            claimNextPendingReference: (now) => context.transactions.claimNextPendingReference(now),
            saveStateAndResult: async (transaction, snapshot, retry) => {
              await context.transactions.saveStateAndResult(transaction, snapshot, retry); staged.transactions++;
            } },
          ledger: { findByWalletAndTransactionId: (wallet, transaction) => context.ledger.findByWalletAndTransactionId(wallet, transaction),
            append: async (entry) => { await context.ledger.append(entry); staged.ledger++; } },
          outbox: { claimNextDue: (now) => context.outbox.claimNextDue(now), save: (message) => context.outbox.save(message),
            append: async (message) => { await context.outbox.append(message); staged.outbox++; } },
        });
        expect(staged).toEqual({ wallets: 1, transactions: 1, ledger: 1, outbox: 2 });
        throw new Error('fault after all writes, before commit');
      }),
    };
    await expect(new CreateWalletUseCase(failing).execute({ playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) })).rejects.toThrow('fault after all writes');
    for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages']) {
      expect((await db.pool.query<{ count: string }>(`select count(*) from ${table}`)).rows[0]?.count).toBe('0');
    }
  });
  test('positive opening has one credit, version one and two outbox events; zero has no financial rows', async () => {
    const create = new CreateWalletUseCase(persistence);
    for (const amount of ['100.00', '0.00']) {
      const wallet = await create.execute({ playerId: randomUUID(), initialBalance: Money.from({ amount, currency: 'BRL' }) });
      expect(wallet.version).toBe(1);
      const rows = await db.pool.query<{ count: string; sum: string }>('select count(*), coalesce(sum(amount),0)::numeric(20,2)::text as sum from wallet_ledger_entries where wallet_id=$1', [wallet.id]);
      expect(rows.rows[0]).toEqual({ count: amount === '0.00' ? '0' : '1', sum: amount });
      const events = await db.pool.query<{ count: string }>('select count(*) from outbox_messages where payload->>\'correlationId\' in (select id from wager_transactions where wallet_id=$1)', [wallet.id]);
      expect(events.rows[0]?.count).toBe(amount === '0.00' ? '0' : '2');
    }
  });
  test('PostgreSQL rejects NaN and infinities in each monetary column', async () => {
    const wallet = await new CreateWalletUseCase(persistence).execute({ playerId: randomUUID(), initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    for (const value of ['NaN', 'Infinity', '-Infinity']) {
      const code = value === 'NaN' ? '23514' : '22003';
      await expect(db.pool.query('update wallets set balance_amount=$1::numeric where id=$2', [value, wallet.id])).rejects.toMatchObject({ code });
      await expect(db.pool.query('update wager_transactions set amount=$1::numeric where wallet_id=$2', [value, wallet.id])).rejects.toMatchObject({ code });
      // INSERT exercises monetary checks without the independent immutable trigger masking them.
      for (const column of ['amount', 'balance_before', 'balance_after']) {
        await expect(db.pool.query(`insert into wallet_ledger_entries (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
          select $1,wallet_id,transaction_id,direction,${column === 'amount' ? '$2::numeric' : 'amount'},currency,
          ${column === 'balance_before' ? '$2::numeric' : 'balance_before'},${column === 'balance_after' ? '$2::numeric' : 'balance_after'},created_at
          from wallet_ledger_entries where wallet_id=$3`, [randomUUID(), value, wallet.id])).rejects.toMatchObject({ code });
      }
    }
  });
});
