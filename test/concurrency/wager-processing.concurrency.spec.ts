import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';

import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from '../../src/wagering/application/wager-processing.persistence.js';
import { FailureCode } from '../../src/wagering/domain/failure-code.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status.js';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.js';
import { createWagerProcessingDatabase, type WagerProcessingDatabase } from '../helpers/wager-processing-database.js';
import {
  expectWalletState, loadLedger, loadTransaction, seedWallet, wagerInput,
} from '../helpers/wager-processing-fixtures.js';

function signal() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out coordinating PostgreSQL transactions')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface WaitingLock {
  pid: number;
  blocking_pids: number[];
  query: string;
  wait_event_type: string;
}

async function waitForWalletLock(database: WagerProcessingDatabase): Promise<WaitingLock> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await database.pool.query<WaitingLock>(`
      select pid, pg_blocking_pids(pid) as blocking_pids, query, wait_event_type
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and state = 'active' and wait_event_type = 'Lock'
        and query ilike '%wallets%' and query ilike '%for update%'
        and cardinality(pg_blocking_pids(pid)) > 0
    `);
    const row = waiting.rows[0];
    if (row !== undefined) {
      return row;
    }
    // Database lock state is the barrier; this delay only limits observer polling.
    await delay(10);
  }
  throw new Error('Did not observe a PostgreSQL wallet lock waiter');
}

function holdAfterWalletLock(persistence: WagerProcessingPersistence) {
  const acquired = signal();
  const release = signal();
  const held: WagerProcessingPersistence = {
    transactional: (work) => persistence.transactional((context) => work({
      ...context,
      wallets: {
        save: (wallet) => context.wallets.save(wallet),
        findByIdForUpdate: async (id) => {
          const wallet = await context.wallets.findByIdForUpdate(id);
          acquired.resolve();
          await withTimeout(release.promise);
          return wallet;
        },
      },
    })),
  };
  return { acquired, release, useCase: new ProcessWagerTransactionUseCase(held) };
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('pessimistic wagering concurrency in PostgreSQL', () => {
  let database: WagerProcessingDatabase;
  let persistence: MikroOrmWagerProcessingPersistence;
  let useCase: ProcessWagerTransactionUseCase;
  const queries: string[] = [];

  beforeAll(async () => {
    database = await createWagerProcessingDatabase((sql) => queries.push(sql));
    persistence = new MikroOrmWagerProcessingPersistence(database.orm.em);
    useCase = new ProcessWagerTransactionUseCase(persistence);
  }, 30_000);

  afterAll(async () => { await database?.close(); }, 30_000);

  test('100.00 and two concurrent BETs of 80.00 produce exactly one debit and one rejection', async () => {
    const wallet = await seedWallet(database);
    const inputA = wagerInput(wallet, Kind.Bet, '80.00');
    const inputB = wagerInput(wallet, Kind.Bet, '80.00');
    for (const field of ['id', 'externalTransactionId', 'idempotencyKey', 'payloadHash'] as const) {
      expect(inputA[field]).not.toBe(inputB[field]);
    }

    const held = holdAfterWalletLock(persistence);
    const first = held.useCase.execute(inputA);
    const settledFirst = Promise.allSettled([first]);
    let second: ReturnType<ProcessWagerTransactionUseCase['execute']> | undefined;
    let settledSecond: Promise<unknown> | undefined;
    let observed: WaitingLock | undefined;
    try {
      await withTimeout(held.acquired.promise);
      second = useCase.execute(inputB);
      settledSecond = Promise.allSettled([second]);
      observed = await waitForWalletLock(database);
      expect(observed.blocking_pids).toHaveLength(1);
      expect(observed.blocking_pids[0]).not.toBe(observed.pid);
      expect(observed.query).toMatch(/select .*wallets.*where .*id.*for update/i);
      expect(observed.wait_event_type).toBe('Lock');
      expect(await loadTransaction(database, inputB.id)).toBeUndefined();
    } finally {
      held.release.resolve();
      await Promise.all([settledFirst, settledSecond]);
    }
    if (second === undefined || observed === undefined) {
      throw new Error('Both financial executions must compete for the wallet lock');
    }
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.status === Status.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.status === Status.Rejected)).toHaveLength(1);
    expect(results[0].status).toBe(Status.Processed);
    expect(results[1].status).toBe(Status.Rejected);
    expect(results[1].failureCode).toBe(FailureCode.InsufficientFunds);
    for (const result of results) {
      expect(result.balance.toJSON().amount).toBe('20.00');
      expect(result.walletVersion).toBe(2);
    }
    expect(results[1].ledgerEntryId).toBeUndefined();

    await expectWalletState(database, wallet, '20.00', 2);
    const transactionA = await loadTransaction(database, inputA.id);
    const transactionB = await loadTransaction(database, inputB.id);
    expect(transactionA?.status).toBe(Status.Processed);
    expect(transactionB?.status).toBe(Status.Rejected);
    expect(transactionB?.failureCode).toBe(FailureCode.InsufficientFunds);
    const debit = await loadLedger(database, inputA.id);
    expect(debit.rows).toHaveLength(1);
    expect(debit.rows[0]).toMatchObject({
      direction: LedgerDirection.Debit, amount: '80.00',
      balance_before: '100.00', balance_after: '20.00',
    });
    expect((await loadLedger(database, inputB.id)).rows).toHaveLength(0);
    const allEntries = await database.pool.query<{ direction: LedgerDirection }>(
      'select direction from wallet_ledger_entries where wallet_id = $1', [wallet.id],
    );
    expect(allEntries.rows).toHaveLength(2); // opening CREDIT and one BET DEBIT
    expect(allEntries.rows.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);
    expect(queries.some((sql) => /select .*wallets.*where .*id.*for update/i.test(sql))).toBe(true);
    console.info('Observed PostgreSQL lock wait:', JSON.stringify(observed));
  }, 15_000);

  test('wallet B commits while a financial execution still holds wallet A locked', async () => {
    const walletA = await seedWallet(database);
    const walletB = await seedWallet(database);
    const inputA = wagerInput(walletA, Kind.Bet);
    const inputB = wagerInput(walletB, Kind.Win);
    const held = holdAfterWalletLock(persistence);
    const first = held.useCase.execute(inputA);
    const settledFirst = Promise.allSettled([first]);
    let second: ReturnType<ProcessWagerTransactionUseCase['execute']> | undefined;
    let settledSecond: Promise<unknown> | undefined;
    try {
      await withTimeout(held.acquired.promise);
      second = useCase.execute(inputB);
      settledSecond = Promise.allSettled([second]);
      const resultB = await withTimeout(second);
      expect(resultB.status).toBe(Status.Processed);
      // B has already committed, although A's release promise is unresolved.
      await expectWalletState(database, walletB, '125.00', 2);
      expect((await loadTransaction(database, inputB.id))?.status).toBe(Status.Processed);
      await expectWalletState(database, walletA, '100.00', 1);
      expect(await loadTransaction(database, inputA.id)).toBeUndefined();
    } finally {
      held.release.resolve();
      await Promise.all([settledFirst, settledSecond]);
    }
    await first;
    await expectWalletState(database, walletA, '75.00', 2);
    await expectWalletState(database, walletB, '125.00', 2);
  }, 15_000);

  test('LOSS waits for its wallet lock and returns the balance committed ahead of it', async () => {
    const wallet = await seedWallet(database);
    const betInput = wagerInput(wallet, Kind.Bet, '80.00');
    const lossInput = wagerInput(wallet, Kind.Loss, '80.00');
    const held = holdAfterWalletLock(persistence);
    const bet = held.useCase.execute(betInput);
    const settledBet = Promise.allSettled([bet]);
    let loss: ReturnType<ProcessWagerTransactionUseCase['execute']> | undefined;
    let settledLoss: Promise<unknown> | undefined;
    try {
      await withTimeout(held.acquired.promise);
      loss = useCase.execute(lossInput);
      settledLoss = Promise.allSettled([loss]);
      await waitForWalletLock(database);
      expect(await loadTransaction(database, lossInput.id)).toBeUndefined();
    } finally {
      held.release.resolve();
      await Promise.all([settledBet, settledLoss]);
    }
    if (loss === undefined) {
      throw new Error('Expected a concurrent LOSS execution');
    }
    await bet;
    const result = await loss;
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('20.00');
    expect(result.walletVersion).toBe(2);
    expect(result.ledgerEntryId).toBeUndefined();
    expect((await loadTransaction(database, lossInput.id))?.money.toJSON().amount).toBe('80.00');
    expect((await loadLedger(database, lossInput.id)).rows).toHaveLength(0);
    const loaded = await expectWalletState(database, wallet, '20.00', 2);
    expect((await loadTransaction(database, betInput.id))?.processedAt).toEqual(loaded.updatedAt);
  }, 15_000);
});
