import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { IMigrator } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Pool } from 'pg';

import {
  parseEnvironment,
  type ApplicationConfiguration,
} from '../../src/config/application.config.js';
import { Money } from '../../src/shared/domain/value-objects/money.js';
import { FailureCode } from '../../src/wagering/domain/failure-code.js';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.js';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.js';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.js';
import { Wallet } from '../../src/wallet/domain/wallet.js';
import { WalletLedgerEntryEntity } from '../../src/persistence/mikro-orm/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/persistence/mikro-orm/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../src/persistence/mikro-orm/entities/wallet.entity.js';
import { createMikroOrmOptions } from '../../src/persistence/mikro-orm/mikro-orm.options.js';
import { MikroOrmWagerTransactionRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerEntryRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmWalletRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wallet.repository.js';

const shouldRun = process.env.RUN_INTEGRATION_TESTS === 'true';
const testDatabaseName = `wagering_stage3_${process.pid}_${Date.now()}`;
const instant = new Date('2026-09-04T12:00:00.000Z');

interface WalletRow {
  id: string;
  playerId?: string;
  currency?: string;
  balanceAmount?: string;
  version?: number;
}

interface TransactionRow {
  id: string;
  walletId: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  kind?: string;
  amount?: string;
  currency?: string;
  referenceExternalTransactionId?: string | null;
  status?: string;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  processedAt?: Date | null;
}

interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction?: string;
  amount?: string;
  currency?: string;
  balanceBefore?: string;
  balanceAfter?: string;
}

describe.skipIf(!shouldRun)('financial persistence', () => {
  let maintenancePool: Pool | undefined;
  let databasePool: Pool | undefined;
  let orm: MikroORM | undefined;
  let migrator: IMigrator | undefined;
  let testDatabaseCreated = false;
  let migrationUpValidated = false;
  let migrationDownValidated = false;

  function activePool(): Pool {
    if (databasePool === undefined) {
      throw new Error('Integration database pool is not initialized');
    }

    return databasePool;
  }

  function activeOrm(): MikroORM {
    if (orm === undefined) {
      throw new Error('Integration MikroORM is not initialized');
    }

    return orm;
  }

  async function expectDatabaseFailure(
    operation: () => Promise<unknown>,
    expectedMessage?: string,
  ): Promise<void> {
    let caught: unknown;

    try {
      await operation();
    } catch (error) {
      caught = error;
    }

    if (caught === undefined) {
      throw new Error('Expected PostgreSQL to reject the operation');
    }

    if (expectedMessage !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain(expectedMessage);
    }
  }

  async function insertWallet({
    id,
    playerId = `player-${id}`,
    currency = 'BRL',
    balanceAmount = '100.00',
    version = 1,
  }: WalletRow): Promise<void> {
    await activePool().query(
      `insert into wallets
        (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $6)`,
      [id, playerId, currency, balanceAmount, version, instant],
    );
  }

  async function insertTransaction({
    id,
    walletId,
    providerId = `provider-${id}`,
    externalTransactionId = `external-${id}`,
    idempotencyKey = `idempotency-${id}`,
    kind = WagerTransactionKind.Bet,
    amount = '10.00',
    currency = 'BRL',
    referenceExternalTransactionId = null,
    status = WagerTransactionStatus.Pending,
    referenceTransactionId = null,
    failureCode = null,
    processedAt = null,
  }: TransactionRow): Promise<void> {
    await activePool().query(
      `insert into wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key,
        payload_hash, wallet_id, player_id, round_id, game_id, kind,
        amount, currency, reference_external_transaction_id, created_at,
        status, reference_transaction_id, failure_code, processed_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18
      )`,
      [
        id,
        providerId,
        externalTransactionId,
        idempotencyKey,
        `hash-${id}`,
        walletId,
        `player-${walletId}`,
        `round-${id}`,
        `game-${id}`,
        kind,
        amount,
        currency,
        referenceExternalTransactionId,
        instant,
        status,
        referenceTransactionId,
        failureCode,
        processedAt,
      ],
    );
  }

  async function insertLedger({
    id,
    walletId,
    transactionId,
    direction = LedgerDirection.Credit,
    amount = '10.00',
    currency = 'BRL',
    balanceBefore = '100.00',
    balanceAfter = '110.00',
  }: LedgerRow): Promise<void> {
    await activePool().query(
      `insert into wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        walletId,
        transactionId,
        direction,
        amount,
        currency,
        balanceBefore,
        balanceAfter,
        instant,
      ],
    );
  }

  beforeAll(async () => {
    const configuration = parseEnvironment(process.env);

    if (!/^wagering_stage3_\d+_\d+$/.test(testDatabaseName)) {
      throw new Error('Refusing to use an unexpected integration database name');
    }

    maintenancePool = new Pool({
      host: configuration.database.host,
      port: configuration.database.port,
      database: 'postgres',
      user: configuration.database.user,
      password: configuration.database.password,
    });
    await maintenancePool.query(`create database "${testDatabaseName}"`);
    testDatabaseCreated = true;

    const testConfiguration: ApplicationConfiguration = {
      ...configuration,
      database: {
        ...configuration.database,
        name: testDatabaseName,
      },
    };
    databasePool = new Pool({
      host: testConfiguration.database.host,
      port: testConfiguration.database.port,
      database: testConfiguration.database.name,
      user: testConfiguration.database.user,
      password: testConfiguration.database.password,
    });

    const testOrmOptions = createMikroOrmOptions(testConfiguration);
    const initializedOrm = await MikroORM.init({
      ...testOrmOptions,
      migrations: {
        ...testOrmOptions.migrations,
        snapshot: false,
      },
      entities: [
        WalletEntity,
        WagerTransactionEntity,
        WalletLedgerEntryEntity,
      ],
      entitiesTs: [],
    });
    orm = initializedOrm;
    migrator = initializedOrm.migrator;
    const activeMigrator = migrator;

    await activeMigrator.up();
    const migratedTables = await databasePool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries')`,
    );
    migrationUpValidated = migratedTables.rowCount === 3;

    await activeMigrator.down({ to: 0 });
    const tablesAfterDown = await databasePool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries')`,
    );
    migrationDownValidated = tablesAfterDown.rowCount === 0;

    await activeMigrator.up();
  }, 30_000);

  afterAll(async () => {
    if (orm !== undefined) {
      await orm.close(true);
    }

    if (databasePool !== undefined) {
      await databasePool.end();
    }

    if (maintenancePool !== undefined && testDatabaseCreated) {
      if (!testDatabaseName.startsWith('wagering_stage3_')) {
        throw new Error('Refusing to drop an unexpected database');
      }

      await maintenancePool.query(
        `drop database if exists "${testDatabaseName}" with (force)`,
      );
      await maintenancePool.end();
    } else if (maintenancePool !== undefined) {
      await maintenancePool.end();
    }
  }, 30_000);

  test('runs the migration up, down, and up again', () => {
    expect(migrationUpValidated).toBe(true);
    expect(migrationDownValidated).toBe(true);
  });

  test('creates the required indexes and immutable-ledger trigger', async () => {
    const indexes = await activePool().query<{ indexname: string }>(
      `select indexname
       from pg_indexes
       where schemaname = 'public'
         and tablename in ('wallets', 'wager_transactions', 'wallet_ledger_entries')`,
    );
    const names = new Set(indexes.rows.map(({ indexname }) => indexname));

    expect(names.has('wallets_player_currency_unique')).toBe(true);
    expect(names.has('wager_transactions_provider_external_unique')).toBe(
      true,
    );
    expect(names.has('wager_transactions_idempotency_key_unique')).toBe(true);
    expect(names.has('wager_transactions_wallet_id_index')).toBe(true);
    expect(names.has('wager_transactions_status_index')).toBe(true);
    expect(
      names.has('wallet_ledger_entries_wallet_transaction_unique'),
    ).toBe(true);
    expect(
      names.has('wallet_ledger_entries_wallet_created_id_index'),
    ).toBe(true);

    const triggers = await activePool().query<{ trigger_name: string }>(
      `select trigger_name
       from information_schema.triggers
       where event_object_schema = 'public'
         and event_object_table = 'wallet_ledger_entries'`,
    );
    expect(
      triggers.rows.some(
        ({ trigger_name }) =>
          trigger_name === 'wallet_ledger_entries_immutable_trigger',
      ),
    ).toBe(true);
  });

  test('round-trips Wallet, WagerTransaction, and WalletLedgerEntry exactly', async () => {
    const entityManager = activeOrm().em.fork();
    const walletRepository = new MikroOrmWalletRepository(entityManager);
    const transactionRepository = new MikroOrmWagerTransactionRepository(
      entityManager,
    );
    const ledgerRepository = new MikroOrmWalletLedgerEntryRepository(
      entityManager,
    );
    const unsafeForIeee754 = '9007199254740993.01';
    const wallet = Wallet.open({
      id: 'wallet-round-trip',
      playerId: 'player-round-trip',
      initialBalance: Money.from({
        amount: unsafeForIeee754,
        currency: 'BRL',
      }),
      openedAt: instant,
    });
    const transaction = WagerTransaction.create({
      id: 'transaction-round-trip',
      providerId: 'internal',
      externalTransactionId: 'opening-round-trip',
      idempotencyKey: 'internal:opening-round-trip',
      payloadHash: 'hash-opening-round-trip',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      createdAt: instant,
    });
    const processedAt = new Date('2026-09-04T12:01:00.000Z');
    transaction.markProcessed(undefined, processedAt);
    const entry = WalletLedgerEntry.create({
      id: 'ledger-round-trip',
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore: Money.zero('BRL'),
      balanceAfter: wallet.balance,
      createdAt: processedAt,
    });
    const failedTransaction = WagerTransaction.create({
      id: 'transaction-failed-round-trip',
      providerId: 'provider-round-trip',
      externalTransactionId: 'failed-round-trip',
      idempotencyKey: 'provider-round-trip:failed-round-trip',
      payloadHash: 'hash-failed-round-trip',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-failed',
      gameId: 'game-failed',
      kind: WagerTransactionKind.Loss,
      money: Money.zero('BRL'),
      createdAt: instant,
    });
    failedTransaction.fail(FailureCode.PermanentInfrastructureFailure);
    const referencedTransaction = WagerTransaction.create({
      id: 'transaction-reference-round-trip',
      providerId: 'provider-round-trip',
      externalTransactionId: 'reference-round-trip',
      idempotencyKey: 'provider-round-trip:reference-round-trip',
      payloadHash: 'hash-reference-round-trip',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-reference',
      gameId: 'game-reference',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      referenceExternalTransactionId: transaction.externalTransactionId,
      createdAt: instant,
    });
    referencedTransaction.markProcessed(transaction.id, processedAt);

    await walletRepository.save(wallet);
    await transactionRepository.save(transaction);
    await transactionRepository.save(failedTransaction);
    await transactionRepository.save(referencedTransaction);
    await ledgerRepository.append(entry);
    entityManager.clear();

    const loadedWallet = await walletRepository.findById(wallet.id);
    const loadedTransaction = await transactionRepository.findById(
      transaction.id,
    );
    const loadedFailed = await transactionRepository.findById(
      failedTransaction.id,
    );
    const loadedReferenced = await transactionRepository.findById(
      referencedTransaction.id,
    );
    const loadedEntry = await ledgerRepository.findById(entry.id);

    expect(loadedWallet?.balance.toJSON().amount).toBe(unsafeForIeee754);
    expect(loadedWallet?.version).toBe(1);
    expect(loadedWallet?.createdAt).toEqual(instant);
    expect(loadedTransaction?.kind).toBe(WagerTransactionKind.Opening);
    expect(loadedTransaction?.money.toJSON().amount).toBe(unsafeForIeee754);
    expect(loadedTransaction?.status).toBe(WagerTransactionStatus.Processed);
    expect(loadedTransaction?.processedAt).toEqual(processedAt);
    expect(loadedFailed?.status).toBe(WagerTransactionStatus.Failed);
    expect(loadedFailed?.failureCode).toBe(
      FailureCode.PermanentInfrastructureFailure,
    );
    expect(loadedReferenced?.referenceTransactionId).toBe(transaction.id);
    expect(loadedEntry?.money.toJSON().amount).toBe(unsafeForIeee754);
    expect(loadedEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(loadedEntry?.balanceAfter.toJSON().amount).toBe(unsafeForIeee754);
    expect(loadedEntry?.isBalanced()).toBe(true);

    const numericRow = await activePool().query<{ balance_amount: string }>(
      'select balance_amount from wallets where id = $1',
      [wallet.id],
    );
    expect(numericRow.rows[0]?.balance_amount).toBe(unsafeForIeee754);
  });

  test('enforces wallet uniqueness, non-negative balance, and positive version', async () => {
    await insertWallet({
      id: 'wallet-constraints-base',
      playerId: 'player-wallet-constraints',
    });

    await expectDatabaseFailure(() =>
      insertWallet({
        id: 'wallet-constraints-duplicate',
        playerId: 'player-wallet-constraints',
      }),
    );
    await expectDatabaseFailure(() =>
      insertWallet({ id: 'wallet-negative-balance', balanceAmount: '-0.01' }),
    );
    await expectDatabaseFailure(() =>
      insertWallet({ id: 'wallet-invalid-version', version: 0 }),
    );
  });

  test('enforces transaction unique keys, enums, required references, and wallet FK', async () => {
    await insertWallet({ id: 'wallet-transaction-constraints' });
    await insertTransaction({
      id: 'transaction-constraints-base',
      walletId: 'wallet-transaction-constraints',
      providerId: 'provider-duplicate',
      externalTransactionId: 'external-duplicate',
      idempotencyKey: 'idempotency-duplicate',
    });

    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-provider-duplicate',
        walletId: 'wallet-transaction-constraints',
        providerId: 'provider-duplicate',
        externalTransactionId: 'external-duplicate',
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-idempotency-duplicate',
        walletId: 'wallet-transaction-constraints',
        idempotencyKey: 'idempotency-duplicate',
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-invalid-kind',
        walletId: 'wallet-transaction-constraints',
        kind: 'INVALID_KIND',
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-invalid-status',
        walletId: 'wallet-transaction-constraints',
        status: 'INVALID_STATUS',
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-invalid-failure-code',
        walletId: 'wallet-transaction-constraints',
        status: WagerTransactionStatus.Rejected,
        failureCode: 'INVALID_FAILURE_CODE',
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-refund-without-reference',
        walletId: 'wallet-transaction-constraints',
        kind: WagerTransactionKind.Refund,
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-rollback-without-reference',
        walletId: 'wallet-transaction-constraints',
        kind: WagerTransactionKind.Rollback,
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-missing-wallet',
        walletId: 'wallet-does-not-exist',
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-rejected-without-code',
        walletId: 'wallet-transaction-constraints',
        status: WagerTransactionStatus.Rejected,
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-processed-without-date',
        walletId: 'wallet-transaction-constraints',
        status: WagerTransactionStatus.Processed,
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-processed-refund-without-internal-reference',
        walletId: 'wallet-transaction-constraints',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'external-bet-reference',
        status: WagerTransactionStatus.Processed,
        processedAt: instant,
      }),
    );
    await expectDatabaseFailure(() =>
      insertTransaction({
        id: 'transaction-processed-rollback-without-internal-reference',
        walletId: 'wallet-transaction-constraints',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'external-bet-reference',
        status: WagerTransactionStatus.Processed,
        processedAt: instant,
      }),
    );
  });

  test('enforces ledger uniqueness, non-negative values, and arithmetic', async () => {
    await insertWallet({ id: 'wallet-ledger-constraints' });
    await insertTransaction({
      id: 'transaction-ledger-valid',
      walletId: 'wallet-ledger-constraints',
    });
    await insertLedger({
      id: 'ledger-valid',
      walletId: 'wallet-ledger-constraints',
      transactionId: 'transaction-ledger-valid',
    });

    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-duplicate',
        walletId: 'wallet-ledger-constraints',
        transactionId: 'transaction-ledger-valid',
      }),
    );

    await insertTransaction({
      id: 'transaction-ledger-negative-amount',
      walletId: 'wallet-ledger-constraints',
    });
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-negative-amount',
        walletId: 'wallet-ledger-constraints',
        transactionId: 'transaction-ledger-negative-amount',
        amount: '-1.00',
        balanceAfter: '99.00',
      }),
    );

    await insertTransaction({
      id: 'transaction-ledger-negative-before',
      walletId: 'wallet-ledger-constraints',
    });
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-negative-before',
        walletId: 'wallet-ledger-constraints',
        transactionId: 'transaction-ledger-negative-before',
        balanceBefore: '-1.00',
        balanceAfter: '9.00',
      }),
    );

    await insertTransaction({
      id: 'transaction-ledger-negative-after',
      walletId: 'wallet-ledger-constraints',
    });
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-negative-after',
        walletId: 'wallet-ledger-constraints',
        transactionId: 'transaction-ledger-negative-after',
        direction: LedgerDirection.Debit,
        amount: '1.00',
        balanceBefore: '0.00',
        balanceAfter: '-1.00',
      }),
    );

    await insertTransaction({
      id: 'transaction-ledger-bad-credit',
      walletId: 'wallet-ledger-constraints',
    });
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-bad-credit',
        walletId: 'wallet-ledger-constraints',
        transactionId: 'transaction-ledger-bad-credit',
        balanceAfter: '109.99',
      }),
    );

    await insertTransaction({
      id: 'transaction-ledger-invalid-direction',
      walletId: 'wallet-ledger-constraints',
    });
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-invalid-direction',
        walletId: 'wallet-ledger-constraints',
        transactionId: 'transaction-ledger-invalid-direction',
        direction: 'INVALID_DIRECTION',
      }),
    );

    await insertTransaction({
      id: 'transaction-ledger-bad-debit',
      walletId: 'wallet-ledger-constraints',
    });
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-bad-debit',
        walletId: 'wallet-ledger-constraints',
        transactionId: 'transaction-ledger-bad-debit',
        direction: LedgerDirection.Debit,
        balanceAfter: '89.99',
      }),
    );
  });

  test('enforces ledger wallet and transaction foreign keys, including wallet consistency', async () => {
    await insertWallet({ id: 'wallet-ledger-fk-one' });
    await insertWallet({ id: 'wallet-ledger-fk-two' });
    await insertTransaction({
      id: 'transaction-ledger-fk',
      walletId: 'wallet-ledger-fk-one',
    });

    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-missing-wallet',
        walletId: 'wallet-ledger-fk-missing',
        transactionId: 'transaction-ledger-fk',
      }),
    );
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-missing-transaction',
        walletId: 'wallet-ledger-fk-one',
        transactionId: 'transaction-ledger-fk-missing',
      }),
    );
    await expectDatabaseFailure(() =>
      insertLedger({
        id: 'ledger-wallet-mismatch',
        walletId: 'wallet-ledger-fk-two',
        transactionId: 'transaction-ledger-fk',
      }),
    );
  });

  test('blocks UPDATE and DELETE on the ledger in PostgreSQL', async () => {
    await insertWallet({ id: 'wallet-ledger-immutable' });
    await insertTransaction({
      id: 'transaction-ledger-immutable',
      walletId: 'wallet-ledger-immutable',
    });
    await insertLedger({
      id: 'ledger-immutable',
      walletId: 'wallet-ledger-immutable',
      transactionId: 'transaction-ledger-immutable',
    });

    await expectDatabaseFailure(
      () =>
        activePool().query(
          `update wallet_ledger_entries
           set balance_after = '120.00'
           where id = 'ledger-immutable'`,
        ),
      'wallet_ledger_entries is immutable',
    );
    await expectDatabaseFailure(
      () =>
        activePool().query(
          `delete from wallet_ledger_entries where id = 'ledger-immutable'`,
        ),
      'wallet_ledger_entries is immutable',
    );

    const preserved = await activePool().query<{
      balance_after: string;
    }>(
      'select balance_after from wallet_ledger_entries where id = $1',
      ['ledger-immutable'],
    );
    expect(preserved.rows[0]?.balance_after).toBe('110.00');
  });

  test('does not cascade-delete financial records', async () => {
    await insertWallet({ id: 'wallet-delete-restricted' });
    await insertTransaction({
      id: 'transaction-delete-restricted',
      walletId: 'wallet-delete-restricted',
    });
    await insertLedger({
      id: 'ledger-delete-restricted',
      walletId: 'wallet-delete-restricted',
      transactionId: 'transaction-delete-restricted',
    });

    await expectDatabaseFailure(() =>
      activePool().query(
        `delete from wager_transactions where id = 'transaction-delete-restricted'`,
      ),
    );
    await expectDatabaseFailure(() =>
      activePool().query(
        `delete from wallets where id = 'wallet-delete-restricted'`,
      ),
    );
  });
});
