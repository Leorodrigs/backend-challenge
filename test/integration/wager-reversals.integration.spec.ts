import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { ClaimedWagerTransactionProcessor } from '../../src/wagering/application/claimed-wager-transaction.processor.js';
import { PendingReferenceRetryPolicy } from '../../src/wagering/application/pending-reference-retry-policy.js';
import { PendingReferenceWorker } from '../../src/wagering/application/pending-reference.worker.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from '../../src/wagering/application/wager-processing.persistence.js';
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

interface RetryRow {
  reference_attempt_count: number;
  reference_next_attempt_at: Date | null;
  reference_deadline_at: Date | null;
  result_balance_amount: string;
  result_wallet_version: number;
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('wager reversals and pending references in PostgreSQL', () => {
  let database: WagerProcessingDatabase;
  let persistence: MikroOrmWagerProcessingPersistence;
  let useCase: ProcessWagerTransactionUseCase;
  let worker: PendingReferenceWorker;

  beforeAll(async () => {
    database = await createWagerProcessingDatabase();
    persistence = new MikroOrmWagerProcessingPersistence(database.orm.em);
    const processor = new ClaimedWagerTransactionProcessor();
    useCase = new ProcessWagerTransactionUseCase(persistence, processor);
    worker = new PendingReferenceWorker(persistence, processor);
  }, 30_000);

  afterAll(async () => { await database?.close(); }, 30_000);

  async function retryRow(transactionId: string): Promise<RetryRow> {
    const result = await database.pool.query<RetryRow>(`
      select reference_attempt_count, reference_next_attempt_at,
        reference_deadline_at, result_balance_amount::text, result_wallet_version
      from wager_transactions where id = $1
    `, [transactionId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Expected retry row');
    return row;
  }

  test('REFUND reverses a processed BET with one exact CREDIT', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const bet = wagerInput(wallet, Kind.Bet, '25.00', { roundId });
    const betResult = await useCase.execute(bet);
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    const result = await useCase.execute(refund);
    const transaction = await loadTransaction(database, refund);
    const ledger = await loadLedger(database, refund);

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(3);
    expect(transaction?.referenceTransactionId).toBe(betResult.transactionId);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      direction: LedgerDirection.Credit,
      amount: '25.00',
      balance_before: '75.00',
      balance_after: '100.00',
    });
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test.each([
    [Kind.Bet, '75.00', LedgerDirection.Credit],
    [Kind.Win, '125.00', LedgerDirection.Debit],
  ] as const)('ROLLBACK inverts a processed %s', async (referenceKind, before, direction) => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const reference = wagerInput(wallet, referenceKind, '25.00', { roundId });
    const referenceResult = await useCase.execute(reference);
    const rollback = wagerInput(wallet, Kind.Rollback, '25.00', {
      roundId,
      referenceExternalTransactionId: reference.payload.externalTransactionId,
    });

    const result = await useCase.execute(rollback);
    const transaction = await loadTransaction(database, rollback);
    const ledger = await loadLedger(database, rollback);

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(3);
    expect(transaction?.referenceTransactionId).toBe(referenceResult.transactionId);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      direction,
      amount: '25.00',
      balance_before: before,
      balance_after: '100.00',
    });
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('ROLLBACK of REFUND debits the exact refund amount', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const bet = wagerInput(wallet, Kind.Bet, '25.00', { roundId });
    await useCase.execute(bet);
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    const refundResult = await useCase.execute(refund);
    const rollback = wagerInput(wallet, Kind.Rollback, '25.00', {
      roundId,
      referenceExternalTransactionId: refund.payload.externalTransactionId,
    });

    const result = await useCase.execute(rollback);
    expect(result.status).toBe(Status.Processed);
    expect((await loadTransaction(database, rollback))?.referenceTransactionId).toBe(refundResult.transactionId);
    expect((await loadLedger(database, rollback)).rows[0]).toMatchObject({
      direction: LedgerDirection.Debit,
      balance_before: '100.00',
      balance_after: '75.00',
    });
    await expectWalletState(database, wallet, '75.00', 4);
  });

  test('amount mismatch is rejected without consuming the processed-reversal slot', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const bet = wagerInput(wallet, Kind.Bet, '25.00', { roundId });
    await useCase.execute(bet);
    const mismatch = wagerInput(wallet, Kind.Refund, '20.00', {
      roundId,
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    const rejected = await useCase.execute(mismatch);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.ReversalAmountMismatch);
    expect(rejected.balance.toJSON().amount).toBe('75.00');
    expect(rejected.walletVersion).toBe(2);
    expect((await loadLedger(database, mismatch)).rows).toHaveLength(0);

    const exact = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    expect((await useCase.execute(exact)).status).toBe(Status.Processed);
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('ROLLBACK debit that would make the wallet negative is auditably rejected', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const win = wagerInput(wallet, Kind.Win, '25.00', { roundId });
    await useCase.execute(win);
    await useCase.execute(wagerInput(wallet, Kind.Bet, '125.00'));
    const rollback = wagerInput(wallet, Kind.Rollback, '25.00', {
      roundId,
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });

    const result = await useCase.execute(rollback);
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReversalWouldMakeBalanceNegative);
    expect(result.balance.toJSON().amount).toBe('0.00');
    expect(result.walletVersion).toBe(3);
    expect((await loadLedger(database, rollback)).rows).toHaveLength(0);
    await expectWalletState(database, wallet, '0.00', 3);
  });

  test('invalid reference kind and round context are rejected before movement', async () => {
    const wallet = await seedWallet(database);
    const win = wagerInput(wallet, Kind.Win, '25.00');
    await useCase.execute(win);
    const refundOfWin = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId: win.payload.roundId,
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });
    const invalidKind = await useCase.execute(refundOfWin);
    expect(invalidKind.status).toBe(Status.Rejected);
    expect(invalidKind.failureCode).toBe(FailureCode.InvalidReference);
    expect((await loadLedger(database, refundOfWin)).rows).toHaveLength(0);

    const bet = wagerInput(wallet, Kind.Bet, '25.00');
    await useCase.execute(bet);
    const wrongRound = wagerInput(wallet, Kind.Rollback, '25.00', {
      roundId: 'another-round',
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    const invalidContext = await useCase.execute(wrongRound);
    expect(invalidContext.status).toBe(Status.Rejected);
    expect(invalidContext.failureCode).toBe(FailureCode.InvalidReference);
    expect((await loadLedger(database, wrongRound)).rows).toHaveLength(0);
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('sequential duplicate REFUND is rejected and PostgreSQL independently enforces the partial unique index', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const bet = wagerInput(wallet, Kind.Bet, '25.00', { roundId });
    await useCase.execute(bet);
    const first = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    const firstResult = await useCase.execute(first);
    const second = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    const rejected = await useCase.execute(second);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await loadLedger(database, second)).rows).toHaveLength(0);
    await expect(database.pool.query(`
      insert into wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        reference_external_transaction_id, created_at, status,
        reference_transaction_id, failure_code, processed_at,
        result_balance_amount, result_balance_currency, result_wallet_version,
        reference_attempt_count, reference_next_attempt_at, reference_deadline_at
      )
      select $1, provider_id, $2, $3, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        reference_external_transaction_id, created_at, status,
        reference_transaction_id, failure_code, processed_at,
        result_balance_amount, result_balance_currency, result_wallet_version,
        reference_attempt_count, reference_next_attempt_at, reference_deadline_at
      from wager_transactions where id = $4
    `, [randomUUID(), `external-${randomUUID()}`, `key-${randomUUID()}`, firstResult.transactionId]))
      .rejects.toMatchObject({
        code: '23505',
        constraint: 'wager_transactions_processed_reversal_unique',
      });
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('out-of-order REFUND uses provider plus external ID, persists retry metadata, and replays both states', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const referenceExternalTransactionId = `shared-${randomUUID()}`;
    // A different provider with the same external ID must not satisfy the lookup.
    await useCase.execute(wagerInput(wallet, Kind.Loss, '25.00', {
      providerId: 'decoy-provider',
      roundId,
      externalTransactionId: referenceExternalTransactionId,
    }));
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      providerId: 'expected-provider',
      roundId,
      referenceExternalTransactionId,
    });

    const pending = await useCase.execute(refund);
    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.balance.toJSON().amount).toBe('100.00');
    expect(pending.walletVersion).toBe(1);
    expect((await loadLedger(database, refund)).rows).toHaveLength(0);
    const initialRetry = await retryRow(pending.transactionId);
    expect(initialRetry.reference_attempt_count).toBe(1);
    expect(initialRetry.reference_next_attempt_at).toBeInstanceOf(Date);
    expect(initialRetry.reference_deadline_at).toBeInstanceOf(Date);
    expect(initialRetry.result_balance_amount).toBe('100.00');
    expect(initialRetry.result_wallet_version).toBe(1);
    const replayPending = await useCase.execute(refund);
    expect(replayPending).toEqual({ ...pending, idempotentReplay: true });
    expect((await retryRow(pending.transactionId)).reference_attempt_count).toBe(1);

    const bet = wagerInput(wallet, Kind.Bet, '25.00', {
      providerId: 'expected-provider',
      roundId,
      externalTransactionId: referenceExternalTransactionId,
    });
    const betResult = await useCase.execute(bet);
    const due = initialRetry.reference_next_attempt_at!;
    expect(await worker.runOnce(new Date(due.getTime() - 1), 1)).toEqual([]);
    const resolvedResults = await worker.runOnce(due, 1);
    expect(resolvedResults).toHaveLength(1);
    const resolved = resolvedResults[0]!;
    expect(resolved?.transactionId).toBe(pending.transactionId);
    expect(resolved?.status).toBe(Status.Processed);
    expect(resolved?.balance.toJSON().amount).toBe('100.00');
    expect(resolved?.walletVersion).toBe(3);
    expect((await loadTransaction(database, refund))?.referenceTransactionId).toBe(betResult.transactionId);
    const cleared = await retryRow(pending.transactionId);
    expect(cleared.reference_attempt_count).toBe(1);
    expect(cleared.reference_next_attempt_at).toBeNull();
    expect(cleared.reference_deadline_at).toBeNull();
    const replayProcessed = await useCase.execute(refund);
    expect(replayProcessed).toEqual({ ...resolved, idempotentReplay: true });
    expect((await loadLedger(database, refund)).rows).toHaveLength(1);
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('out-of-order ROLLBACK resolves the same persisted transaction later', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const referenceExternalTransactionId = `future-${randomUUID()}`;
    const rollback = wagerInput(wallet, Kind.Rollback, '25.00', {
      roundId,
      referenceExternalTransactionId,
    });
    const pending = await useCase.execute(rollback);
    expect(pending.status).toBe(Status.PendingReference);
    const initialRetry = await retryRow(pending.transactionId);

    const bet = wagerInput(wallet, Kind.Bet, '25.00', {
      roundId,
      externalTransactionId: referenceExternalTransactionId,
    });
    const betResult = await useCase.execute(bet);
    const [resolved] = await worker.runOnce(initialRetry.reference_next_attempt_at!, 1);
    expect(resolved?.transactionId).toBe(pending.transactionId);
    expect(resolved?.status).toBe(Status.Processed);
    expect((await loadTransaction(database, rollback))?.referenceTransactionId).toBe(betResult.transactionId);
    expect((await loadLedger(database, rollback)).rows[0]?.direction).toBe(LedgerDirection.Credit);
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('pending ROLLBACK waits for a pending REFUND and resolves after the chain', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const betExternal = `future-bet-${randomUUID()}`;
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: betExternal,
    });
    const pendingRefund = await useCase.execute(refund);
    const rollback = wagerInput(wallet, Kind.Rollback, '25.00', {
      roundId,
      referenceExternalTransactionId: refund.payload.externalTransactionId,
    });
    const pendingRollback = await useCase.execute(rollback);
    expect(pendingRefund.status).toBe(Status.PendingReference);
    expect(pendingRollback.status).toBe(Status.PendingReference);

    await useCase.execute(wagerInput(wallet, Kind.Bet, '25.00', {
      roundId,
      externalTransactionId: betExternal,
    }));
    const firstPass = new Date(Date.now() + 5_000);
    await worker.runOnce(firstPass, 10);
    await worker.runOnce(new Date(firstPass.getTime() + 5_000), 10);

    expect((await loadTransaction(database, refund))?.status).toBe(Status.Processed);
    expect((await loadTransaction(database, rollback))?.status).toBe(Status.Processed);
    expect((await loadTransaction(database, rollback))?.referenceTransactionId).toBe(pendingRefund.transactionId);
    await expectWalletState(database, wallet, '75.00', 4);
  });

  test('attempt exhaustion is persistent, terminal, and snapshots the final locked wallet state', async () => {
    const wallet = await seedWallet(database);
    const processor = new ClaimedWagerTransactionProcessor(new PendingReferenceRetryPolicy({
      baseDelayMs: 10,
      maxDelayMs: 20,
      maxAttempts: 2,
      ttlMs: 1_000,
    }));
    const limitedUseCase = new ProcessWagerTransactionUseCase(persistence, processor);
    const limitedWorker = new PendingReferenceWorker(persistence, processor);
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      referenceExternalTransactionId: `missing-${randomUUID()}`,
    });
    const pending = await limitedUseCase.execute(refund);
    const first = await retryRow(pending.transactionId);
    await useCase.execute(wagerInput(wallet, Kind.Win, '25.00'));

    const [exhausted] = await limitedWorker.runOnce(first.reference_next_attempt_at!, 1);
    expect(exhausted?.status).toBe(Status.Rejected);
    expect(exhausted?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(exhausted?.balance.toJSON().amount).toBe('125.00');
    expect(exhausted?.walletVersion).toBe(2);
    const terminal = await retryRow(pending.transactionId);
    expect(terminal.reference_attempt_count).toBe(2);
    expect(terminal.reference_next_attempt_at).toBeNull();
    expect(terminal.reference_deadline_at).toBeNull();
    expect((await loadLedger(database, refund)).rows).toHaveLength(0);
    expect((await limitedUseCase.execute(refund)).idempotentReplay).toBe(true);
    await expectWalletState(database, wallet, '125.00', 2);
  });

  test('worker failure after resolved writes rolls back status, credit, ledger, snapshot, and retry cleanup', async () => {
    const wallet = await seedWallet(database);
    const roundId = `round-${randomUUID()}`;
    const betExternal = `future-${randomUUID()}`;
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      roundId,
      referenceExternalTransactionId: betExternal,
    });
    const pending = await useCase.execute(refund);
    const before = await retryRow(pending.transactionId);
    await useCase.execute(wagerInput(wallet, Kind.Bet, '25.00', {
      roundId,
      externalTransactionId: betExternal,
    }));
    const failure = new Error('controlled worker failure before commit');
    const failingPersistence: WagerProcessingPersistence = {
      transactional: (work) => persistence.transactional(async (context) => {
        const result = await work(context);
        expect(result).toBeDefined();
        throw failure;
      }),
    };

    await expect(new PendingReferenceWorker(failingPersistence).runOnce(before.reference_next_attempt_at!, 1))
      .rejects.toBe(failure);
    expect((await loadTransaction(database, refund))?.status).toBe(Status.PendingReference);
    expect(await retryRow(pending.transactionId)).toEqual(before);
    expect((await loadLedger(database, refund)).rows).toHaveLength(0);
    await expectWalletState(database, wallet, '75.00', 2);

    expect((await worker.runOnce(before.reference_next_attempt_at!, 1))[0]?.status).toBe(Status.Processed);
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('PostgreSQL rejects inconsistent pending retry metadata', async () => {
    const wallet = await seedWallet(database);
    const refund = wagerInput(wallet, Kind.Refund, '25.00', {
      referenceExternalTransactionId: `missing-${randomUUID()}`,
    });
    const pending = await useCase.execute(refund);

    await expect(database.pool.query(
      'update wager_transactions set reference_attempt_count = -1 where id = $1',
      [pending.transactionId],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'wager_transactions_reference_attempt_count_check',
    });
    await expect(database.pool.query(
      'update wager_transactions set reference_next_attempt_at = null where id = $1',
      [pending.transactionId],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'wager_transactions_reference_schedule_check',
    });
  });
});
