import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';

import { MikroOrmWagerTransactionRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerEntryRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmWalletRepository } from '../../src/persistence/mikro-orm/repositories/mikro-orm-wallet.repository.js';
import { Money } from '../../src/shared/domain/value-objects/money.js';
import type { ProcessWagerTransactionInput } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.js';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.js';
import { Wallet } from '../../src/wallet/domain/wallet.js';
import type { WagerProcessingDatabase } from './wager-processing-database.js';

export const openingTime = new Date('2026-09-04T12:00:00.000Z');
export const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

export function wagerInput(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount = '25.00',
): ProcessWagerTransactionInput {
  const id = randomUUID();
  return {
    id,
    providerId: 'test-provider',
    externalTransactionId: `external-${id}`,
    idempotencyKey: `key-${id}`,
    payloadHash: `hash-${id}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: `round-${id}`,
    gameId: 'test-game',
    kind,
    money: money(amount, wallet.currency),
    createdAt: openingTime,
  };
}

export async function seedWallet(
  database: WagerProcessingDatabase,
  amount = '100.00',
): Promise<Wallet> {
  const wallet = Wallet.open({
    id: randomUUID(), playerId: randomUUID(), initialBalance: money(amount), openedAt: openingTime,
  });
  // OPENING is only a fixture, not an application flow introduced by this stage.
  await database.orm.em.fork().transactional(async (em) => {
    await new MikroOrmWalletRepository(em).save(wallet);
    if (wallet.balance.isZero()) {
      return;
    }
    const opening = WagerTransaction.create(wagerInput(wallet, WagerTransactionKind.Opening, amount));
    opening.markProcessed(undefined, openingTime);
    await new MikroOrmWagerTransactionRepository(em).save(opening);
    await new MikroOrmWalletLedgerEntryRepository(em).append(WalletLedgerEntry.create({
      id: randomUUID(), walletId: wallet.id, transactionId: opening.id,
      direction: LedgerDirection.Credit, money: wallet.balance,
      balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance, createdAt: openingTime,
    }));
  });
  return wallet;
}

export async function expectWalletState(
  database: WagerProcessingDatabase,
  wallet: Wallet,
  amount: string,
  version: number,
): Promise<Wallet> {
  const loaded = await new MikroOrmWalletRepository(database.orm.em.fork()).findById(wallet.id);
  if (loaded === undefined) {
    throw new Error('Expected the fixture wallet to exist');
  }
  expect(loaded.balance.toJSON()).toEqual({ amount, currency: wallet.currency });
  expect(loaded.balance.isNegative()).toBe(false);
  expect(loaded.version).toBe(version);
  if (version === wallet.version) {
    expect(loaded.updatedAt).toEqual(wallet.updatedAt);
  }

  const reconstructed = await database.pool.query<{ balance: string }>(
    `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)
       ::numeric(20,2)::text as balance
     from wallet_ledger_entries where wallet_id = $1`,
    [wallet.id],
  );
  expect(reconstructed.rows[0]?.balance).toBe(loaded.balance.toJSON().amount);
  return loaded;
}

export async function loadTransaction(database: WagerProcessingDatabase, id: string) {
  return new MikroOrmWagerTransactionRepository(database.orm.em.fork()).findById(id);
}

export async function loadLedger(database: WagerProcessingDatabase, transactionId: string) {
  return database.pool.query<{
    id: string;
    wallet_id: string;
    direction: LedgerDirection;
    amount: string;
    currency: string;
    balance_before: string;
    balance_after: string;
    created_at: Date;
  }>('select * from wallet_ledger_entries where transaction_id = $1', [transactionId]);
}
