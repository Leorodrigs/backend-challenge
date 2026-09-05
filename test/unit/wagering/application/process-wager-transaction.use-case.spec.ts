import { describe, expect, mock, spyOn, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import { InsufficientFundsError } from '../../../../src/wallet/domain/errors/wallet.errors.js';
import { LedgerDirection } from '../../../../src/wallet/domain/ledger-direction.js';
import { Wallet, type WalletBalanceChange } from '../../../../src/wallet/domain/wallet.js';
import type { WalletLedgerEntry } from '../../../../src/wallet/domain/wallet-ledger-entry.js';
import { InvalidWagerTransactionError } from '../../../../src/wagering/domain/errors/wager-transaction.errors.js';
import { FailureCode } from '../../../../src/wagering/domain/failure-code.js';
import type { WagerTransaction } from '../../../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind as Kind } from '../../../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../../../src/wagering/domain/wager-transaction-status.js';
import {
  UnsupportedWagerTransactionKindError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../../../src/wagering/application/errors/wager-processing.errors.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../../../src/wagering/application/process-wager-transaction.use-case.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../../../src/wagering/application/wager-processing.persistence.js';

const openedAt = new Date('2026-09-04T12:00:00.000Z');
const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

function setup(balance = '100.00') {
  const wallet = Wallet.open({
    id: 'wallet-1', playerId: 'player-1', initialBalance: money(balance), openedAt,
  });
  const context = {
    wallets: {
      findByIdForUpdate: mock(async (_id: string): Promise<Wallet | undefined> => wallet),
      save: mock(async (_wallet: Wallet): Promise<void> => {}),
    },
    transactions: { save: mock(async (_transaction: WagerTransaction): Promise<void> => {}) },
    ledger: { append: mock(async (_entry: WalletLedgerEntry): Promise<void> => {}) },
  } satisfies WagerProcessingContext;
  const persistence: WagerProcessingPersistence = {
    transactional: async <T>(work: (ctx: WagerProcessingContext) => Promise<T>): Promise<T> => work(context),
  };
  const input: ProcessWagerTransactionInput = {
    id: 'bet-1', providerId: 'provider-1', externalTransactionId: 'external-1',
    idempotencyKey: 'key-1', payloadHash: 'hash-1', walletId: wallet.id,
    playerId: wallet.playerId, roundId: 'round-1', gameId: 'game-1',
    kind: Kind.Bet, money: money('25.00'), createdAt: openedAt,
  };
  return { wallet, context, persistence, input, useCase: new ProcessWagerTransactionUseCase(persistence) };
}

function expectNoWalletWrites(context: ReturnType<typeof setup>['context']): void {
  expect(context.wallets.save).not.toHaveBeenCalled();
  expect(context.ledger.append).not.toHaveBeenCalled();
}

describe('ProcessWagerTransactionUseCase', () => {
  test.each([
    [Kind.Bet, 'debit', LedgerDirection.Debit, '75.00'],
    [Kind.Win, 'credit', LedgerDirection.Credit, '125.00'],
  ] as const)('%s uses the aggregate change for its ledger and a single timestamp', async (kind, method, direction, after) => {
    const { wallet, context, input, useCase } = setup();
    const apply = wallet[method].bind(wallet);
    let change: WalletBalanceChange | undefined;
    const movement = spyOn(wallet, method).mockImplementation((amount, at) => {
      change = apply(amount, at);
      return change;
    });
    const before = wallet.balance;
    const result = await useCase.execute({ ...input, kind });
    const transaction = context.transactions.save.mock.calls[0]?.[0];
    const entry = context.ledger.append.mock.calls[0]?.[0];

    expect(context.wallets.findByIdForUpdate).toHaveBeenCalledWith(wallet.id);
    expect(movement).toHaveBeenCalledTimes(1);
    expect(context.wallets.save).toHaveBeenCalledWith(wallet);
    expect(context.transactions.save).toHaveBeenCalledTimes(1);
    expect(context.ledger.append).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(Status.Processed);
    expect(result.transactionId).toBe(input.id);
    expect(result.balance.toJSON().amount).toBe(after);
    expect(result.walletVersion).toBe(2);
    expect(result.failureCode).toBeUndefined();
    expect(result.ledgerEntryId).toBe(entry?.id);
    expect(entry?.direction).toBe(direction);
    expect(entry?.money).toBe(input.money);
    expect(entry?.balanceBefore).toBe(before);
    expect(entry?.balanceBefore).toBe(change?.balanceBefore);
    expect(entry?.balanceAfter).toBe(change?.balanceAfter);
    expect(entry?.balanceAfter).toBe(result.balance);
    expect(entry?.createdAt).toEqual(transaction?.processedAt);
    expect(transaction?.processedAt).toEqual(wallet.updatedAt);
    expect(transaction?.createdAt).toEqual(openedAt);
    expect(transaction?.payloadHash).toBe(input.payloadHash);
    expect(transaction?.idempotencyKey).toBe(input.idempotencyKey);
    movement.mockRestore();
  });

  test('LOSS preserves its amount, balance, version and timestamp without a ledger', async () => {
    const { wallet, context, input, useCase } = setup();
    const result = await useCase.execute({ ...input, kind: Kind.Loss });

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.save.mock.calls[0]?.[0].money).toBe(input.money);
    expectNoWalletWrites(context);
  });

  test('insufficient BET is saved as REJECTED with no wallet or ledger writes', async () => {
    const { wallet, context, input, useCase } = setup('20.00');
    const result = await useCase.execute(input);

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance.toJSON().amount).toBe('20.00');
    expect(result.walletVersion).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.save.mock.calls[0]?.[0].status).toBe(Status.Rejected);
    expect(context.transactions.save.mock.calls[0]?.[0].processedAt).toBeUndefined();
    expectNoWalletWrites(context);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s rejects currency mismatch without changing the wallet', async (kind) => {
    const { wallet, context, input, useCase } = setup();
    const result = await useCase.execute({ ...input, kind, money: money('25.00', 'USD') });

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.balance.currency).toBe('BRL');
    expect(result.walletVersion).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.save.mock.calls[0]?.[0].failureCode).toBe(FailureCode.CurrencyMismatch);
    expectNoWalletWrites(context);
  });

  test.each([Kind.Opening, Kind.Refund, Kind.Rollback, 'UNKNOWN' as Kind])('rejects unsupported runtime kind %s before persistence', async (kind) => {
    const { context, input, useCase } = setup();
    await expect(useCase.execute({ ...input, kind })).rejects.toBeInstanceOf(UnsupportedWagerTransactionKindError);
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expect(context.transactions.save).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test('missing wallet is an application error with no writes', async () => {
    const { context, input, useCase } = setup();
    context.wallets.findByIdForUpdate.mockResolvedValue(undefined);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(context.transactions.save).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s validates the wallet player before financial effects', async (kind) => {
    const { wallet, context, input, useCase } = setup();
    await expect(useCase.execute({ ...input, kind, playerId: 'another-player' })).rejects.toBeInstanceOf(WalletPlayerMismatchError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(context.transactions.save).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test.each([Kind.Bet, Kind.Win])('%s zero is PROCESSED without financial writes', async (kind) => {
    const { wallet, context, input, useCase } = setup();
    const result = await useCase.execute({ ...input, kind, money: Money.zero('BRL') });
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(result.ledgerEntryId).toBeUndefined();
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.save).toHaveBeenCalledTimes(1);
    expectNoWalletWrites(context);
  });

  test('WIN preserves an optional external reference without resolving it', async () => {
    const { context, input, useCase } = setup();
    await useCase.execute({ ...input, kind: Kind.Win, referenceExternalTransactionId: 'external-bet' });
    const transaction = context.transactions.save.mock.calls[0]?.[0];
    expect(transaction?.status).toBe(Status.Processed);
    expect(transaction?.referenceExternalTransactionId).toBe('external-bet');
    expect(transaction?.referenceTransactionId).toBeUndefined();
  });

  test('delegates input validation to WagerTransaction.create', async () => {
    const { context, input, useCase } = setup();
    await expect(useCase.execute({ ...input, id: '' })).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expect(context.transactions.save).not.toHaveBeenCalled();
  });

  test('unexpected aggregate errors propagate without recording a rejection', async () => {
    const { wallet, context, input, useCase } = setup();
    const error = new Error('unexpected domain failure');
    const debit = spyOn(wallet, 'debit').mockImplementation(() => { throw error; });
    try {
      await expect(useCase.execute(input)).rejects.toBe(error);
      expect(context.transactions.save).not.toHaveBeenCalled();
      expectNoWalletWrites(context);
    } finally {
      debit.mockRestore();
    }
  });

  test('does not mistake repository exceptions for a business rejection', async () => {
    const { context, input, useCase } = setup();
    const error = new InsufficientFundsError();
    context.ledger.append.mockRejectedValue(error);
    await expect(useCase.execute(input)).rejects.toBe(error);
    expect(context.transactions.save).toHaveBeenCalledTimes(1);
    expect(context.transactions.save.mock.calls[0]?.[0].status).toBe(Status.Processed);
  });

  test('propagates a commit failure instead of returning success or retrying', async () => {
    const { context, input } = setup();
    const error = new Error('commit failed');
    const persistence: WagerProcessingPersistence = {
      transactional: async (work) => {
        await work(context);
        throw error;
      },
    };
    await expect(new ProcessWagerTransactionUseCase(persistence).execute(input)).rejects.toBe(error);
    expect(context.transactions.save).toHaveBeenCalledTimes(1);
  });
});
