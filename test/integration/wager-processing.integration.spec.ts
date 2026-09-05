import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { MikroOrmWalletRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wallet.repository.js';
import {
  UnsupportedWagerTransactionKindError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../src/wagering/application/errors/wager-processing.errors.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from '../../src/wagering/application/wager-processing.persistence.js';
import { FailureCode } from '../../src/wagering/domain/failure-code.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status.js';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.js';
import { createWagerProcessingDatabase, type WagerProcessingDatabase } from '../helpers/wager-processing-database.js';
import {
  expectWalletState, loadLedger, loadTransaction, money, seedWallet, wagerInput,
} from '../helpers/wager-processing-fixtures.js';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('wager processing in PostgreSQL', () => {
  let database: WagerProcessingDatabase;
  let persistence: MikroOrmWagerProcessingPersistence;
  let useCase: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    database = await createWagerProcessingDatabase();
    persistence = new MikroOrmWagerProcessingPersistence(database.orm.em);
    useCase = new ProcessWagerTransactionUseCase(persistence);
  }, 30_000);

  afterAll(async () => { await database?.close(); }, 30_000);

  test.each([
    [Kind.Bet, '75.00', LedgerDirection.Debit],
    [Kind.Win, '125.00', LedgerDirection.Credit],
  ] as const)('%s persists the exact wallet change, ledger and terminal transaction', async (kind, after, direction) => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, kind);
    const result = await useCase.execute(input);
    const loaded = await expectWalletState(database, wallet, after, 2);
    const transaction = await loadTransaction(database, input.id);
    const ledger = await loadLedger(database, input.id);

    expect(result.transactionId).toBe(input.id);
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.equals(loaded.balance)).toBe(true);
    expect(result.walletVersion).toBe(2);
    expect(result.failureCode).toBeUndefined();
    expect(transaction?.status).toBe(Status.Processed);
    expect(transaction?.failureCode).toBeUndefined();
    expect(transaction?.money.equals(input.money)).toBe(true);
    expect(transaction?.payloadHash).toBe(input.payloadHash);
    expect(transaction?.idempotencyKey).toBe(input.idempotencyKey);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      id: result.ledgerEntryId, wallet_id: wallet.id, direction, amount: '25.00',
      currency: 'BRL', balance_before: '100.00', balance_after: after,
    });
    expect(ledger.rows[0]?.created_at).toEqual(transaction?.processedAt);
    expect(transaction?.processedAt).toEqual(loaded.updatedAt);
  });

  test('BET insufficient funds commits an auditable rejection only', async () => {
    const wallet = await seedWallet(database, '20.00');
    const input = wagerInput(wallet, Kind.Bet);
    const result = await useCase.execute(input);
    await expectWalletState(database, wallet, '20.00', 1);
    const transaction = await loadTransaction(database, input.id);

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance.toJSON().amount).toBe('20.00');
    expect(result.walletVersion).toBe(1);
    expect(result.ledgerEntryId).toBeUndefined();
    expect(transaction?.status).toBe(Status.Rejected);
    expect(transaction?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction?.processedAt).toBeUndefined();
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
  });

  test('LOSS preserves its amount and wallet balance/version without a ledger', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Loss, '80.00');
    const result = await useCase.execute(input);
    await expectWalletState(database, wallet, '100.00', 1);
    const transaction = await loadTransaction(database, input.id);
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(transaction?.status).toBe(Status.Processed);
    expect(transaction?.processedAt).toBeInstanceOf(Date);
    expect(transaction?.money.toJSON().amount).toBe('80.00');
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s currency mismatch persists REJECTED without financial effects', async (kind) => {
    const wallet = await seedWallet(database);
    const input = { ...wagerInput(wallet, kind), money: money('25.00', 'USD') };
    const result = await useCase.execute(input);
    await expectWalletState(database, wallet, '100.00', 1);
    const transaction = await loadTransaction(database, input.id);

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(result.walletVersion).toBe(1);
    expect(result.ledgerEntryId).toBeUndefined();
    expect(transaction?.status).toBe(Status.Rejected);
    expect(transaction?.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(transaction?.money.currency).toBe('USD');
    expect(transaction?.processedAt).toBeUndefined();
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s player mismatch is an application error with no committed transaction', async (kind) => {
    const wallet = await seedWallet(database);
    const input = { ...wagerInput(wallet, kind), playerId: 'another-player' };
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(WalletPlayerMismatchError);
    await expectWalletState(database, wallet, '100.00', 1);
    expect(await loadTransaction(database, input.id)).toBeUndefined();
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
  });

  test('missing wallet is an application error without persisting financial records', async () => {
    const wallet = await seedWallet(database);
    const input = { ...wagerInput(wallet, Kind.Bet), walletId: 'missing-wallet' };
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(WalletNotFoundError);
    await expectWalletState(database, wallet, '100.00', 1);
    expect(await loadTransaction(database, input.id)).toBeUndefined();
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
  });

  test.each([Kind.Opening, Kind.Refund, Kind.Rollback])('%s remains outside the processing flow', async (kind) => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, kind);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(UnsupportedWagerTransactionKindError);
    await expectWalletState(database, wallet, '100.00', 1);
    expect(await loadTransaction(database, input.id)).toBeUndefined();
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
  });

  test.each([Kind.Bet, Kind.Win])('%s zero is processed without changing balance/version or appending a ledger', async (kind) => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, kind, '0.00');
    const result = await useCase.execute(input);
    await expectWalletState(database, wallet, '100.00', 1);
    expect(result.status).toBe(Status.Processed);
    expect(result.walletVersion).toBe(1);
    expect(result.ledgerEntryId).toBeUndefined();
    expect((await loadTransaction(database, input.id))?.status).toBe(Status.Processed);
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
  });

  test('WIN preserves its optional external reference without an internal lookup', async () => {
    const wallet = await seedWallet(database);
    const input = { ...wagerInput(wallet, Kind.Win), referenceExternalTransactionId: 'unresolved-external-bet' };
    await useCase.execute(input);
    await expectWalletState(database, wallet, '125.00', 2);
    const transaction = await loadTransaction(database, input.id);
    expect(transaction?.status).toBe(Status.Processed);
    expect(transaction?.referenceExternalTransactionId).toBe(input.referenceExternalTransactionId);
    expect(transaction?.referenceTransactionId).toBeUndefined();
  });

  test('keeps cents exact beyond IEEE-754 safe integers through processing and reconciliation', async () => {
    const wallet = await seedWallet(database, '9007199254740993.01');
    await useCase.execute(wagerInput(wallet, Kind.Bet, '0.01'));
    await expectWalletState(database, wallet, '9007199254740993.00', 2);
    await useCase.execute(wagerInput(wallet, Kind.Win, '0.02'));
    await expectWalletState(database, wallet, '9007199254740993.02', 3);
  });

  test('rolls back all three financial records after their real repository flushes', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Bet);
    const failure = new Error('controlled failure before commit');
    // A test-only wrapper throws after the real use case has flushed everything.
    const failing: WagerProcessingPersistence = {
      transactional: (work) => persistence.transactional(async (context) => {
        const result = await work(context);
        expect(result).toBeDefined();
        const stagedWallet = await context.wallets.findByIdForUpdate(wallet.id);
        expect(stagedWallet?.balance.toJSON().amount).toBe('75.00');
        expect(stagedWallet?.version).toBe(2);
        throw failure;
      }),
    };
    await expect(new ProcessWagerTransactionUseCase(failing).execute(input)).rejects.toBe(failure);
    await expectWalletState(database, wallet, '100.00', 1);
    expect(await loadTransaction(database, input.id)).toBeUndefined();
    expect((await loadLedger(database, input.id)).rows).toHaveLength(0);

    // A fresh execution confirms that rollback released the lock and discarded state.
    await useCase.execute(wagerInput(wallet, Kind.Bet));
    await expectWalletState(database, wallet, '75.00', 2);
  });

  test('PostgreSQL ledger insert failure rolls back the earlier wallet and transaction flushes', async () => {
    const wallet = await seedWallet(database);
    const input = wagerInput(wallet, Kind.Win);
    // Restrict the injected trigger to this unique transaction in the disposable DB.
    await database.pool.query(`
      create function stage4_fail_ledger_insert() returns trigger language plpgsql as $$
      begin
        if new.transaction_id = '${input.id}' then
          raise exception 'controlled ledger insert failure' using errcode = '23514';
        end if;
        return new;
      end; $$;
      create trigger stage4_fail_ledger_insert before insert on wallet_ledger_entries
      for each row execute function stage4_fail_ledger_insert();
    `);
    try {
      await expect(useCase.execute(input)).rejects.toThrow('controlled ledger insert failure');
      await expectWalletState(database, wallet, '100.00', 1);
      expect(await loadTransaction(database, input.id)).toBeUndefined();
      expect((await loadLedger(database, input.id)).rows).toHaveLength(0);
    } finally {
      await database.pool.query('drop trigger stage4_fail_ledger_insert on wallet_ledger_entries');
      await database.pool.query('drop function stage4_fail_ledger_insert()');
    }
  });

  test('requires an active SQL transaction for pessimistic wallet reads', async () => {
    const wallet = await seedWallet(database);
    const repository = new MikroOrmWalletRepository(database.orm.em.fork());
    await expect(repository.findByIdForUpdate(wallet.id)).rejects.toThrow('An open transaction is required');
    await expectWalletState(database, wallet, '100.00', 1);
  });
});
