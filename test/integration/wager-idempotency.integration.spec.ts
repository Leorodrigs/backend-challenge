import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { MikroOrmWagerTransactionRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository.js';
import { ExternalTransactionConflictError, IdempotencyConflictError, WagerResultUnavailableError } from '../../src/wagering/application/errors/wager-processing.errors.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from '../../src/wagering/application/wager-processing.persistence.js';
import { WagerPayloadHasher } from '../../src/wagering/application/wager-payload-hasher.js';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction.js';
import { FailureCode } from '../../src/wagering/domain/failure-code.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status.js';
import { createWagerProcessingDatabase, type WagerProcessingDatabase } from '../helpers/wager-processing-database.js';
import { expectWalletState, loadLedger, loadTransaction, money, seedWallet, wagerInput } from '../helpers/wager-processing-fixtures.js';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('persistent wager idempotency in PostgreSQL', () => {
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

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s replays the same logical response and preserves all financial records', async (kind) => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, kind);
    const original = await useCase.execute(input);
    const queryStart = queries.length;
    // A new application object/EntityManager reads the committed result from PostgreSQL.
    const fresh = new ProcessWagerTransactionUseCase(new MikroOrmWagerProcessingPersistence(database.orm.em.fork()));
    const replay = await fresh.execute(input);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(original.idempotentReplay).toBe(false);
    expect(queries.slice(queryStart).some((sql) => /from "wallets".*for update/i.test(sql))).toBe(false);
    await expectWalletState(database, wallet, kind === Kind.Bet ? '75.00' : kind === Kind.Win ? '125.00' : '100.00', kind === Kind.Loss ? 1 : 2);
    const rows = await database.pool.query<{ id: string; payload_hash: string }>('select id, payload_hash from wager_transactions where idempotency_key = $1', [input.idempotencyKey]);
    expect(rows.rows).toEqual([{ id: original.transactionId, payload_hash: new WagerPayloadHasher().hash(input.payload) }]);
    expect((await loadLedger(database, original.transactionId)).rows).toHaveLength(kind === Kind.Loss ? 0 : 1);
  });

  test('historical BET returns 75.00/version 2 after a WIN raises the wallet to 125.00/version 3', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const original = await useCase.execute(input);
    await useCase.execute(wagerInput(wallet, Kind.Win, '50.00'));
    const replay = await useCase.execute(input);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance.toJSON().amount).toBe('75.00');
    expect(replay.walletVersion).toBe(2);
    await expectWalletState(database, wallet, '125.00', 3);
  });

  test('insufficient BET remains rejected at historical 20.00 after a WIN raises the wallet to 120.00', async () => {
    const wallet = await seedWallet(database, '20.00');
    const input = wagerInput(wallet, Kind.Bet);
    const original = await useCase.execute(input);
    expect(original.idempotentReplay).toBe(false);
    await useCase.execute(wagerInput(wallet, Kind.Win, '100.00'));
    const replay = await useCase.execute(input);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.status).toBe(Status.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.balance.toJSON().amount).toBe('20.00');
    expect(replay.walletVersion).toBe(1);
    expect((await loadLedger(database, input)).rows).toHaveLength(0);
    await expectWalletState(database, wallet, '120.00', 2);
  });

  test.each([Kind.Loss, Kind.Win, Kind.Bet])('%s retains the historical snapshot without a ledger (LOSS, zero, currency rejection)', async (kind) => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, kind, kind === Kind.Win ? '0.00' : '25.00',
      kind === Kind.Bet ? { money: money('25.00', 'USD') } : {});
    const original = await useCase.execute(input);
    await useCase.execute(wagerInput(wallet, Kind.Win, '50.00'));
    const replay = await useCase.execute(input);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(replay.walletVersion).toBe(1);
    expect(replay.ledgerEntryId).toBeUndefined();
    expect(replay.failureCode).toBe(kind === Kind.Bet ? FailureCode.CurrencyMismatch : undefined);
    expect((await loadLedger(database, input)).rows).toHaveLength(0);
    await expectWalletState(database, wallet, '150.00', 2);
  });

  test('conflicting amount, wallet, currency, kind and external ID leave the original row and finances untouched', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    await useCase.execute(input);
    const before = await database.pool.query('select * from wager_transactions where idempotency_key = $1', [input.idempotencyKey]);
    for (const change of [
      { money: money('30.00') }, { walletId: 'absent-wallet' }, { money: money('25.00', 'USD') },
      { kind: Kind.Win }, { externalTransactionId: 'another-external' },
    ]) {
      const start = queries.length;
      await expect(useCase.execute({ ...input, payload: { ...input.payload, ...change } })).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(queries.slice(start).some((sql) => /from "wallets".*for update/i.test(sql))).toBe(false);
    }
    expect((await database.pool.query('select * from wager_transactions where idempotency_key = $1', [input.idempotencyKey])).rows).toEqual(before.rows);
    expect((await loadLedger(database, input)).rows).toHaveLength(1);
    await expectWalletState(database, wallet, '75.00', 2);
  });

  test('same provider/external with another key is a typed conflict, never a replay', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    await useCase.execute(input);
    const other = { ...input, idempotencyKey: randomUUID() };
    await expect(useCase.execute(other)).rejects.toBeInstanceOf(ExternalTransactionConflictError);
    expect(await loadTransaction(database, other)).toBeUndefined();
    expect((await loadLedger(database, input)).rows).toHaveLength(1);
    await expectWalletState(database, wallet, '75.00', 2);
  });

  test('when different existing rows conflict on key and provider/external, the key is classified first', async () => {
    const wallet = await seedWallet(database);
    const first = wagerInput(wallet, Kind.Bet);
    const second = wagerInput(wallet, Kind.Win);
    await useCase.execute(first);
    await useCase.execute(second);
    await expect(useCase.execute({ ...second, idempotencyKey: first.idempotencyKey })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expectWalletState(database, wallet, '100.00', 3);
  });

  test('historical NUMERIC snapshot round-trips cents beyond the IEEE-754 safe integer range', async () => {
    const wallet = await seedWallet(database, '9007199254740993.01');
    const input = wagerInput(wallet, Kind.Bet, '0.01');
    const original = await useCase.execute(input);
    await useCase.execute(wagerInput(wallet, Kind.Win, '0.02'));
    const replay = await useCase.execute(input);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance.toJSON().amount).toBe('9007199254740993.00');
    const row = await database.pool.query<{ result_balance_amount: string }>('select result_balance_amount from wager_transactions where id = $1', [original.transactionId]);
    expect(row.rows[0]?.result_balance_amount).toBe('9007199254740993.00');
    expect(typeof row.rows[0]?.result_balance_amount).toBe('string');
    await expectWalletState(database, wallet, '9007199254740993.02', 3);
  });

  test('failure after claim and all flushes rolls back claim, snapshot, wallet and ledger; the identical retry succeeds', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const failure = new Error('controlled failure after snapshot before commit');
    let rolledBackCandidateId: string | undefined;
    const failing: WagerProcessingPersistence = {
      transactional: (work) => persistence.transactional(async (context) => {
        const result = await work({
          ...context,
          transactions: {
            ...context.transactions,
            tryClaim: async (candidate) => {
              const claimed = await context.transactions.tryClaim(candidate);
              rolledBackCandidateId = candidate.id;
              expect(claimed).toBe(true);
              const pending = await context.transactions.findByIdempotencyKey(input.idempotencyKey);
              expect(pending?.transaction.status).toBe(Status.Pending);
              expect(pending?.snapshot).toBeUndefined();
              return claimed;
            },
            findByIdempotencyKey: (key) => context.transactions.findByIdempotencyKey(key),
            findByProviderAndExternalTransactionId: (provider, external) => context.transactions.findByProviderAndExternalTransactionId(provider, external),
            saveStateAndResult: (transaction, snapshot, retry) => context.transactions.saveStateAndResult(transaction, snapshot, retry),
            hasProcessedReversal: (reference, kind) => context.transactions.hasProcessedReversal(reference, kind),
            claimNextPendingReference: (now) => context.transactions.claimNextPendingReference(now),
          },
        });
        expect(result).toBeDefined();
        const staged = await context.transactions.findByIdempotencyKey(input.idempotencyKey);
        expect(staged?.transaction.status).toBe(Status.Processed);
        expect(staged?.snapshot?.balance.toJSON().amount).toBe('75.00');
        expect(staged?.snapshot?.walletVersion).toBe(2);
        expect(await loadTransaction(database, input)).toBeUndefined();
        throw failure;
      }),
    };
    await expect(new ProcessWagerTransactionUseCase(failing).execute(input)).rejects.toBe(failure);
    expect(await loadTransaction(database, input)).toBeUndefined();
    expect((await loadLedger(database, input)).rows).toHaveLength(0);
    await expectWalletState(database, wallet, '100.00', 1);
    const retry = await useCase.execute(input);
    expect(retry.idempotentReplay).toBe(false);
    expect(rolledBackCandidateId).not.toBe(retry.transactionId);
    expect((await loadLedger(database, input)).rows).toHaveLength(1);
    await expectWalletState(database, wallet, '75.00', 2);
  });

  test('snapshot constraints reject partial results, negative/NaN balance, invalid currency and version', async () => {
    const wallet = await seedWallet(database);
    const original = await useCase.execute(wagerInput(wallet, Kind.Bet));
    const invalid: Array<readonly [string | null, string | null, number | null, string]> = [
      ['1.00', null, null, 'all_or_none'], [null, 'BRL', null, 'all_or_none'], [null, null, 1, 'all_or_none'],
      ['1.00', 'BRL', null, 'all_or_none'], ['1.00', null, 1, 'all_or_none'], [null, 'BRL', 1, 'all_or_none'],
      ['-0.01', 'BRL', 1, 'balance'], ['NaN', 'BRL', 1, 'balance'], ['1.00', 'brl', 1, 'currency'], ['1.00', 'BRL', 0, 'version'],
    ];
    for (const [amount, currency, version, constraint] of invalid) {
      await expect(database.pool.query(
        'update wager_transactions set result_balance_amount = $1, result_balance_currency = $2, result_wallet_version = $3 where id = $4',
        [amount, currency, version, original.transactionId],
      )).rejects.toMatchObject({ code: '23514', constraint: `wager_transactions_result_${constraint}_check` });
    }
    await expectWalletState(database, wallet, '75.00', 2);
  });

  test('legacy rows survive reversible migration without a fabricated snapshot; pending and terminal replay are explicit', async () => {
    const wallet = await seedWallet(database);
    const repository = new MikroOrmWagerTransactionRepository(database.orm.em.fork());
    const inputs = [wagerInput(wallet, Kind.Loss), wagerInput(wallet, Kind.Bet)];
    for (const input of inputs) {
      const legacy = WagerTransaction.create({ ...input.payload, id: randomUUID(), idempotencyKey: input.idempotencyKey, payloadHash: new WagerPayloadHasher().hash(input.payload) });
      if (input.payload.kind === Kind.Loss) legacy.markProcessed(undefined, new Date());
      await repository.save(legacy);
    }
    await database.orm.migrator.down({ to: 'Migration20260904000100_require_processed_reference' });
    const columnsDown = await database.pool.query("select column_name from information_schema.columns where table_name = 'wager_transactions' and column_name like 'result_%'");
    expect(columnsDown.rows).toHaveLength(0);
    const oldFk = await database.pool.query<{ condeferrable: boolean }>("select condeferrable from pg_constraint where conname = 'wager_transactions_wallet_fk'");
    expect(oldFk.rows[0]?.condeferrable).toBe(false);
    await database.orm.migrator.up();
    expect(await database.orm.schema.getUpdateSchemaSQL({ wrap: false })).toBe('');
    const columns = await database.pool.query<{ column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null; character_maximum_length: number | null }>(
      "select column_name, data_type, numeric_precision, numeric_scale, character_maximum_length from information_schema.columns where table_name = 'wager_transactions' and column_name like 'result_%' order by column_name",
    );
    expect(columns.rows).toHaveLength(3);
    expect(columns.rows[0]).toMatchObject({ column_name: 'result_balance_amount', data_type: 'numeric', numeric_precision: 20, numeric_scale: 2 });
    expect(columns.rows[1]).toMatchObject({ column_name: 'result_balance_currency', data_type: 'character varying', character_maximum_length: 3 });
    expect(columns.rows[2]).toMatchObject({ column_name: 'result_wallet_version', data_type: 'integer' });
    for (const input of inputs) {
      expect((await repository.findByIdempotencyKey(input.idempotencyKey))?.snapshot).toBeUndefined();
      await expect(useCase.execute(input)).rejects.toBeInstanceOf(WagerResultUnavailableError);
    }
    await expectWalletState(database, wallet, '100.00', 1);
  });

  test('claim requires an active SQL transaction and the deferred FK still rejects a missing wallet at commit', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet, '25.00', { walletId: 'missing-wallet' });
    const candidate = WagerTransaction.create({ ...input.payload, id: randomUUID(), idempotencyKey: input.idempotencyKey, payloadHash: new WagerPayloadHasher().hash(input.payload) });
    await expect(new MikroOrmWagerTransactionRepository(database.orm.em.fork()).tryClaim(candidate)).rejects.toThrow('An open transaction is required');
    await expect(database.orm.em.fork().transactional(async (em) => {
      expect(await new MikroOrmWagerTransactionRepository(em).tryClaim(candidate)).toBe(true);
    })).rejects.toThrow('wager_transactions_wallet_fk');
    expect(await loadTransaction(database, input)).toBeUndefined();
    await expectWalletState(database, wallet, '100.00', 1);
  });
});
