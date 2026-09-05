import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';

import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { ExternalTransactionConflictError, IdempotencyConflictError } from '../../src/wagering/application/errors/wager-processing.errors.js';
import type { WagerProcessingPersistence } from '../../src/wagering/application/wager-processing.persistence.js';
import { FailureCode } from '../../src/wagering/domain/failure-code.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status.js';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.js';
import { createWagerProcessingDatabase, type WagerProcessingDatabase } from '../helpers/wager-processing-database.js';
import {
  expectWalletState, loadLedger, loadTransaction, money, seedWallet, wagerInput,
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

async function waitForClaimLock(database: WagerProcessingDatabase): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await database.pool.query(`
      select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and state = 'active' and wait_event_type = 'Lock'
        and query ilike '%insert into wager_transactions%'
        and cardinality(pg_blocking_pids(pid)) > 0
    `);
    if (waiting.rows.length > 0) return;
    await delay(10);
  }
  throw new Error('Did not observe a PostgreSQL concurrent claim waiter');
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

  test('50 identical parallel BETs use different candidate IDs and commit exactly one debit', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const candidateIds: string[] = [];
    const winnerLocked = signal();
    const releaseWinner = signal();
    const queryStart = queries.length;
    const executions = Array.from({ length: 50 }, () => {
      const independent = new MikroOrmWagerProcessingPersistence(database.orm.em.fork());
      const observed: WagerProcessingPersistence = {
        transactional: (work) => independent.transactional((context) => work({
          ...context,
          transactions: {
            tryClaim: async (candidate) => {
              candidateIds.push(candidate.id);
              return context.transactions.tryClaim(candidate);
            },
            findByIdempotencyKey: (key) => context.transactions.findByIdempotencyKey(key),
            findByProviderAndExternalTransactionId: (provider, external) => context.transactions.findByProviderAndExternalTransactionId(provider, external),
            saveStateAndResult: (transaction, snapshot, retry) => context.transactions.saveStateAndResult(transaction, snapshot, retry),
            hasProcessedReversal: (reference, kind) => context.transactions.hasProcessedReversal(reference, kind),
            claimNextPendingReference: (now) => context.transactions.claimNextPendingReference(now),
          },
          wallets: {
            save: (value) => context.wallets.save(value),
            findByIdForUpdate: async (id) => {
              const locked = await context.wallets.findByIdForUpdate(id);
              winnerLocked.resolve();
              await withTimeout(releaseWinner.promise);
              return locked;
            },
          },
        })),
      };
      return new ProcessWagerTransactionUseCase(observed).execute(input);
    });
    const settledPromise = Promise.allSettled(executions);
    try {
      await withTimeout(winnerLocked.promise);
      await waitForClaimLock(database);
      // All ORM connections can be busy with claims; observe through the separate pool.
      const uncommitted = await database.pool.query('select id from wager_transactions where idempotency_key = $1', [input.idempotencyKey]);
      expect(uncommitted.rows).toHaveLength(0);
    } finally {
      releaseWinner.resolve();
      await settledPromise;
    }
    const settled = await settledPromise;
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(50);
    expect(rejected).toHaveLength(0);
    const results = fulfilled.map(({ value }) => value);
    const winner = results.find((result) => !result.idempotentReplay);
    if (winner === undefined) throw new Error('Expected exactly one original result');
    expect(new Set(candidateIds).size).toBe(50);
    expect(new Set(results.map(({ transactionId }) => transactionId)).size).toBe(1);
    expect(results.filter(({ idempotentReplay }) => !idempotentReplay)).toHaveLength(1);
    expect(results.filter(({ idempotentReplay }) => idempotentReplay)).toHaveLength(49);
    for (const result of results) {
      expect(result).toEqual({ ...winner, idempotentReplay: result.idempotentReplay });
      expect(result.status).toBe(Status.Processed);
      expect(result.balance.toJSON().amount).toBe('75.00');
      expect(result.walletVersion).toBe(2);
    }
    expect(queries.slice(queryStart).filter((sql) => /from "wallets".*for update/i.test(sql))).toHaveLength(1);
    const stored = await database.pool.query<{ id: string }>('select id from wager_transactions where idempotency_key = $1', [input.idempotencyKey]);
    expect(stored.rows).toEqual([{ id: winner.transactionId }]);
    expect(candidateIds).toContain(winner.transactionId);
    const ledger = await loadLedger(database, input);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ direction: LedgerDirection.Debit, amount: '25.00' });
    const allEntries = await database.pool.query<{ direction: LedgerDirection }>('select direction from wallet_ledger_entries where wallet_id = $1', [wallet.id]);
    expect(allEntries.rows).toHaveLength(2);
    expect(allEntries.rows.filter(({ direction }) => direction === LedgerDirection.Credit)).toHaveLength(1);
    expect(allEntries.rows.filter(({ direction }) => direction === LedgerDirection.Debit)).toHaveLength(1);
    const loaded = await expectWalletState(database, wallet, '75.00', 2);
    console.info('50-request idempotency evidence:', JSON.stringify({
      calls: settled.length, fulfilled: fulfilled.length, rejected: rejected.length,
      distinctCandidateIds: new Set(candidateIds).size,
      distinctTransactionIds: new Set(results.map(({ transactionId }) => transactionId)).size,
      idempotentReplayFalse: results.filter(({ idempotentReplay }) => !idempotentReplay).length,
      idempotentReplayTrue: results.filter(({ idempotentReplay }) => idempotentReplay).length,
      wagerTransactions: stored.rows.length, debits: ledger.rows.length,
      finalBalance: loaded.balance.toJSON().amount, finalVersion: loaded.version,
    }));
  }, 30_000);

  test('simultaneous different payloads with one key produce one winner and one typed conflict', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const changed = { ...input, payload: { ...input.payload, money: money('30.00') } };
    const held = holdAfterWalletLock(persistence);
    const settled = Promise.allSettled([held.useCase.execute(input), held.useCase.execute(changed)]);
    try {
      await withTimeout(held.acquired.promise);
      await waitForClaimLock(database);
    } finally {
      held.release.resolve();
      await settled;
    }
    const results = await settled;
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(IdempotencyConflictError);
    const winner = fulfilled[0]?.value;
    if (winner === undefined) throw new Error('Expected a committed winner');
    expect(winner.idempotentReplay).toBe(false);
    const ledger = await loadLedger(database, input);
    expect(ledger.rows).toHaveLength(1);
    expect(['25.00', '30.00']).toContain(ledger.rows[0]?.amount ?? '');
    await expectWalletState(database, wallet, ledger.rows[0]?.amount === '25.00' ? '75.00' : '70.00', 2);
    expect((await loadTransaction(database, input))?.id).toBe(winner.transactionId);
  }, 15_000);

  test('simultaneous provider/external duplicates under different keys yield an external-operation conflict', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const other = { ...input, idempotencyKey: `${input.idempotencyKey}-other` };
    const held = holdAfterWalletLock(persistence);
    const settled = Promise.allSettled([held.useCase.execute(input), held.useCase.execute(other)]);
    try {
      await withTimeout(held.acquired.promise);
      await waitForClaimLock(database);
    } finally {
      held.release.resolve();
      await settled;
    }
    const results = await settled;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ExternalTransactionConflictError);
    await expectWalletState(database, wallet, '75.00', 2);
  }, 15_000);

  test('two distinct claims coexist before competing for the same wallet without an FK lock-upgrade deadlock', async () => {
    const wallet = await seedWallet(database);
    const bothClaimed = signal();
    let claims = 0;
    const coordinated: WagerProcessingPersistence = {
      transactional: (work) => persistence.transactional((context) => work({
        ...context,
        transactions: {
          tryClaim: async (candidate) => {
            const claimed = await context.transactions.tryClaim(candidate);
            expect(claimed).toBe(true);
            if (++claims === 2) bothClaimed.resolve();
            await withTimeout(bothClaimed.promise);
            return claimed;
          },
          findByIdempotencyKey: (key) => context.transactions.findByIdempotencyKey(key),
          findByProviderAndExternalTransactionId: (provider, external) => context.transactions.findByProviderAndExternalTransactionId(provider, external),
          saveStateAndResult: (transaction, snapshot, retry) => context.transactions.saveStateAndResult(transaction, snapshot, retry),
            hasProcessedReversal: (reference, kind) => context.transactions.hasProcessedReversal(reference, kind),
            claimNextPendingReference: (now) => context.transactions.claimNextPendingReference(now),
        },
      })),
    };
    const processor = new ProcessWagerTransactionUseCase(coordinated);
    const settled = await Promise.allSettled([
      processor.execute(wagerInput(wallet, Kind.Bet, '80.00')),
      processor.execute(wagerInput(wallet, Kind.Bet, '80.00')),
    ]);
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled.filter(({ value }) => value.status === Status.Processed)).toHaveLength(1);
    expect(fulfilled.filter(({ value }) => value.failureCode === FailureCode.InsufficientFunds)).toHaveLength(1);
    await expectWalletState(database, wallet, '20.00', 2);
  }, 15_000);

  test('100.00 and two concurrent BETs of 80.00 produce exactly one debit and one rejection', async () => {
    const wallet = await seedWallet(database);
    const inputA = wagerInput(wallet, Kind.Bet, '80.00');
    const inputB = wagerInput(wallet, Kind.Bet, '80.00');
    expect(inputA.idempotencyKey).not.toBe(inputB.idempotencyKey);
    expect(inputA.payload.externalTransactionId).not.toBe(inputB.payload.externalTransactionId);

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
      expect(await loadTransaction(database, inputB)).toBeUndefined();
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
    const transactionA = await loadTransaction(database, inputA);
    const transactionB = await loadTransaction(database, inputB);
    expect(transactionA?.status).toBe(Status.Processed);
    expect(transactionB?.status).toBe(Status.Rejected);
    expect(transactionB?.failureCode).toBe(FailureCode.InsufficientFunds);
    const debit = await loadLedger(database, inputA);
    expect(debit.rows).toHaveLength(1);
    expect(debit.rows[0]).toMatchObject({
      direction: LedgerDirection.Debit, amount: '80.00',
      balance_before: '100.00', balance_after: '20.00',
    });
    expect((await loadLedger(database, inputB)).rows).toHaveLength(0);
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
      expect((await loadTransaction(database, inputB))?.status).toBe(Status.Processed);
      await expectWalletState(database, walletA, '100.00', 1);
      expect(await loadTransaction(database, inputA)).toBeUndefined();
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
      expect(await loadTransaction(database, lossInput)).toBeUndefined();
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
    expect((await loadTransaction(database, lossInput))?.money.toJSON().amount).toBe('80.00');
    expect((await loadLedger(database, lossInput)).rows).toHaveLength(0);
    const loaded = await expectWalletState(database, wallet, '20.00', 2);
    expect((await loadTransaction(database, betInput))?.processedAt).toEqual(loaded.updatedAt);
  }, 15_000);
});
