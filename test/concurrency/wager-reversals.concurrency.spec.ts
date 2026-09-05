import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { PendingReferenceWorker } from '../../src/wagering/application/pending-reference.worker.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../src/wagering/application/wager-processing.persistence.js';
import { FailureCode } from '../../src/wagering/domain/failure-code.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status.js';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.js';
import { createWagerProcessingDatabase, type WagerProcessingDatabase } from '../helpers/wager-processing-database.js';
import {
  expectWalletState,
  loadLedger,
  loadTransaction,
  seedWallet,
  wagerInput,
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
        timer = setTimeout(
          () => reject(new Error('Timed out coordinating pending reference workers')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function independentUseCase(database: WagerProcessingDatabase): ProcessWagerTransactionUseCase {
  return new ProcessWagerTransactionUseCase(
    new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
  );
}

function delegateTransactions(
  context: WagerProcessingContext,
  claimNextPendingReference: WagerProcessingContext['transactions']['claimNextPendingReference'],
): WagerProcessingContext['transactions'] {
  return {
    tryClaim: (transaction) => context.transactions.tryClaim(transaction),
    findByIdempotencyKey: (key) => context.transactions.findByIdempotencyKey(key),
    findByProviderAndExternalTransactionId: (providerId, externalId) =>
      context.transactions.findByProviderAndExternalTransactionId(providerId, externalId),
    saveStateAndResult: (transaction, snapshot, retryState) =>
      context.transactions.saveStateAndResult(transaction, snapshot, retryState),
    hasProcessedReversal: (referenceTransactionId, kind) =>
      context.transactions.hasProcessedReversal(referenceTransactionId, kind),
    claimNextPendingReference,
  };
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('reversal concurrency in PostgreSQL', () => {
  let database: WagerProcessingDatabase;
  let persistence: MikroOrmWagerProcessingPersistence;
  let useCase: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    database = await createWagerProcessingDatabase();
    persistence = new MikroOrmWagerProcessingPersistence(database.orm.em);
    useCase = new ProcessWagerTransactionUseCase(persistence);
  }, 30_000);

  afterAll(async () => { await database?.close(); }, 30_000);

  test('two distinct simultaneous REFUNDs of one BET commit one CREDIT', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const bet = wagerInput(wallet, Kind.Bet, '25.00', { roundId });
    const betResult = await useCase.execute(bet);
    const refunds = [
      wagerInput(wallet, Kind.Refund, '25.00', {
        roundId,
        referenceExternalTransactionId: bet.payload.externalTransactionId,
      }),
      wagerInput(wallet, Kind.Refund, '25.00', {
        roundId,
        referenceExternalTransactionId: bet.payload.externalTransactionId,
      }),
    ];

    const results = await Promise.all(refunds.map((input) => independentUseCase(database).execute(input)));
    expect(results.filter((result) => result.status === Status.Processed)).toHaveLength(1);
    const rejected = results.find((result) => result.status === Status.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await loadLedger(database, refunds[0]!)).rows.length +
      (await loadLedger(database, refunds[1]!)).rows.length).toBe(1);
    const rows = await database.pool.query<{ count: string }>(`
      select count(*)::text as count from wager_transactions
      where reference_transaction_id = $1 and kind = 'REFUND' and status = 'PROCESSED'
    `, [betResult.transactionId]);
    expect(rows.rows[0]?.count).toBe('1');
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('two distinct simultaneous ROLLBACKs of one WIN commit one DEBIT', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const win = wagerInput(wallet, Kind.Win, '25.00', { roundId });
    const winResult = await useCase.execute(win);
    const rollbacks = [
      wagerInput(wallet, Kind.Rollback, '25.00', {
        roundId,
        referenceExternalTransactionId: win.payload.externalTransactionId,
      }),
      wagerInput(wallet, Kind.Rollback, '25.00', {
        roundId,
        referenceExternalTransactionId: win.payload.externalTransactionId,
      }),
    ];

    const results = await Promise.all(rollbacks.map((input) => independentUseCase(database).execute(input)));
    expect(results.filter((result) => result.status === Status.Processed)).toHaveLength(1);
    const rejected = results.find((result) => result.status === Status.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    const ledgers = [
      ...(await loadLedger(database, rollbacks[0]!)).rows,
      ...(await loadLedger(database, rollbacks[1]!)).rows,
    ];
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]?.direction).toBe(LedgerDirection.Debit);
    const rows = await database.pool.query<{ count: string }>(`
      select count(*)::text as count from wager_transactions
      where reference_transaction_id = $1 and kind = 'ROLLBACK' and status = 'PROCESSED'
    `, [winResult.transactionId]);
    expect(rows.rows[0]?.count).toBe('1');
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('50 simultaneous retries of the same REFUND remain one operation and one CREDIT', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const bet = wagerInput(wallet, Kind.Bet, '25.00', { roundId });
    await useCase.execute(bet);
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => independentUseCase(database).execute(refund)),
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);
    expect(results.every((result) => result.status === Status.Processed)).toBe(true);
    expect(results.every((result) => result.failureCode === undefined)).toBe(true);
    expect((await loadLedger(database, refund)).rows).toHaveLength(1);
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('two worker instances cannot claim the same pending row while its lock is held', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const betExternal = `future-${randomUUID()}`;
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: betExternal,
    });
    const pending = await useCase.execute(refund);
    const retry = await database.pool.query<{ reference_next_attempt_at: Date }>(
      'select reference_next_attempt_at from wager_transactions where id = $1',
      [pending.transactionId],
    );
    await useCase.execute(wagerInput(wallet, Kind.Bet, '25.00', {
      roundId,
      externalTransactionId: betExternal,
    }));
    const due = retry.rows[0]!.reference_next_attempt_at;
    const acquired = signal();
    const release = signal();
    const heldPersistence: WagerProcessingPersistence = {
      transactional: (work) => persistence.transactional((context) => work({
        ...context,
        transactions: delegateTransactions(context, async (now) => {
          const claimed = await context.transactions.claimNextPendingReference(now);
          if (claimed !== undefined) {
            acquired.resolve();
            await withTimeout(release.promise);
          }
          return claimed;
        }),
      })),
    };
    const firstWorker = new PendingReferenceWorker(heldPersistence);
    const secondWorker = new PendingReferenceWorker(
      new MikroOrmWagerProcessingPersistence(database.orm.em.fork()),
    );
    const firstRun = firstWorker.runOnce(due, 1);

    try {
      await withTimeout(acquired.promise);
      const skipped = await withTimeout(secondWorker.runOnce(due, 1));
      expect(skipped).toEqual([]);
      expect((await loadTransaction(database, refund))?.status).toBe(Status.PendingReference);
    } finally {
      release.resolve();
    }

    const processed = await withTimeout(firstRun);
    expect(processed).toHaveLength(1);
    expect(processed[0]?.transactionId).toBe(pending.transactionId);
    expect(processed[0]?.status).toBe(Status.Processed);
    expect((await loadLedger(database, refund)).rows).toHaveLength(1);
    await expectWalletState(database, wallet, '100.00', 3);
  });
});
