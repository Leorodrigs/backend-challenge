import { describe, expect, test } from 'bun:test';

import { CurrencyMismatchError } from '../../../../src/shared/domain/errors/money.errors.js';
import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import {
  InsufficientFundsError,
  InvalidWalletAmountError,
  InvalidWalletBalanceError,
  InvalidWalletDateError,
  InvalidWalletIdentifierError,
  InvalidWalletVersionError,
} from '../../../../src/wallet/domain/errors/wallet.errors.js';
import { Wallet } from '../../../../src/wallet/domain/wallet.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

const openedAt = new Date('2026-09-03T10:00:00.000Z');

const openWallet = (initialBalance = money('100.00')): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    openedAt,
  });

describe('Wallet', () => {
  test('opens with its initial balance currency and version one', () => {
    const wallet = openWallet();

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('opens with a zero balance', () => {
    const wallet = openWallet(Money.zero('BRL'));

    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  test.each([
    { id: '', playerId: 'player-1' },
    { id: ' ', playerId: 'player-1' },
    { id: ' wallet-1 ', playerId: 'player-1' },
    { id: 'wallet-1', playerId: '' },
    { id: 'wallet-1', playerId: ' ' },
    { id: 'wallet-1', playerId: ' player-1 ' },
  ])('rejects invalid identifiers: %o', ({ id, playerId }) => {
    expect(() =>
      Wallet.open({ id, playerId, initialBalance: money('10.00'), openedAt }),
    ).toThrow(InvalidWalletIdentifierError);
  });

  test('rejects a negative opening balance', () => {
    expect(() => openWallet(money('10.00').negate())).toThrow(
      InvalidWalletBalanceError,
    );
  });

  test('rejects an invalid opening date', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('10.00'),
        openedAt: new Date(Number.NaN),
      }),
    ).toThrow(InvalidWalletDateError);
  });

  test('credits balance and returns the exact change', () => {
    const wallet = openWallet();
    const creditedAt = new Date('2026-09-03T10:01:00.000Z');

    const change = wallet.credit(money('25.00'), creditedAt);

    expect(wallet.balance.toJSON()).toEqual({
      amount: '125.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(creditedAt);
    expect(change?.balanceBefore.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(change?.balanceAfter.toJSON()).toEqual({
      amount: '125.00',
      currency: 'BRL',
    });
    expect(change?.versionBefore).toBe(1);
    expect(change?.versionAfter).toBe(2);
  });

  test('debits balance and returns the exact change', () => {
    const wallet = openWallet();
    const debitedAt = new Date('2026-09-03T10:02:00.000Z');

    const change = wallet.debit(money('25.00'), debitedAt);

    expect(wallet.balance.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(debitedAt);
    expect(change?.balanceBefore.toJSON().amount).toBe('100.00');
    expect(change?.balanceAfter.toJSON().amount).toBe('75.00');
    expect(change?.versionBefore).toBe(1);
    expect(change?.versionAfter).toBe(2);
  });

  test('allows debit of the exact available balance', () => {
    const wallet = openWallet();

    wallet.debit(money('100.00'), new Date('2026-09-03T10:01:00.000Z'));

    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(2);
  });

  test('preserves all mutable state when funds are insufficient', () => {
    const wallet = openWallet();
    const originalUpdatedAt = wallet.updatedAt;
    let caught: unknown;

    try {
      wallet.debit(
        money('100.01'),
        new Date('2026-09-03T10:01:00.000Z'),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InsufficientFundsError);
    expect((caught as Error).message).toBe('Insufficient funds');
    expect(caught).not.toHaveProperty('availableBalance');
    expect(caught).not.toHaveProperty('attemptedDebit');
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(originalUpdatedAt);
  });

  test('preserves all mutable state when a change date is invalid', () => {
    const wallet = openWallet();
    const originalUpdatedAt = wallet.updatedAt;

    expect(() => wallet.credit(money('1.00'), new Date(Number.NaN))).toThrow(
      InvalidWalletDateError,
    );

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(originalUpdatedAt);
  });

  test('rejects currency mismatches without partially changing state', () => {
    const wallet = openWallet();
    const originalUpdatedAt = wallet.updatedAt;
    const at = new Date('2026-09-03T10:01:00.000Z');

    expect(() => wallet.credit(money('25.00', 'USD'), at)).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.debit(money('25.00', 'USD'), at)).toThrow(
      CurrencyMismatchError,
    );

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(originalUpdatedAt);
  });

  test('rejects negative credit and debit amounts', () => {
    const wallet = openWallet();
    const negative = money('1.00').negate();
    const at = new Date('2026-09-03T10:01:00.000Z');
    let caught: unknown;

    try {
      wallet.credit(negative, at);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidWalletAmountError);
    expect((caught as Error).message).toBe(
      'Wallet credit amount must not be negative',
    );
    expect(caught).not.toHaveProperty('amount');
    expect(() => wallet.debit(negative, at)).toThrow(InvalidWalletAmountError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('increments version only for real balance changes', () => {
    const wallet = openWallet();
    const creditedAt = new Date('2026-09-03T10:01:00.000Z');
    const debitedAt = new Date('2026-09-03T10:02:00.000Z');

    wallet.credit(money('10.00'), creditedAt);
    expect(wallet.version).toBe(2);

    wallet.debit(money('5.00'), debitedAt);
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(debitedAt);
  });

  test('treats zero credit and debit as no-ops', () => {
    const wallet = openWallet();
    const originalUpdatedAt = wallet.updatedAt;
    const later = new Date('2026-09-03T11:00:00.000Z');

    expect(wallet.credit(Money.zero('BRL'), later)).toBeUndefined();
    expect(wallet.debit(Money.zero('BRL'), later)).toBeUndefined();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(originalUpdatedAt);
  });

  test('still validates currency for zero-value operations', () => {
    const wallet = openWallet();
    const later = new Date('2026-09-03T11:00:00.000Z');

    expect(() => wallet.credit(Money.zero('USD'), later)).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.debit(Money.zero('USD'), later)).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.version).toBe(1);
  });

  test('defensively copies dates received and returned by the wallet', () => {
    const inputOpenedAt = new Date('2026-09-03T10:00:00.000Z');
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('100.00'),
      openedAt: inputOpenedAt,
    });
    const creditedAt = new Date('2026-09-03T10:01:00.000Z');

    wallet.credit(money('1.00'), creditedAt);
    inputOpenedAt.setUTCFullYear(1990);
    creditedAt.setUTCFullYear(1990);

    const exposedCreatedAt = wallet.createdAt;
    const exposedUpdatedAt = wallet.updatedAt;
    exposedCreatedAt.setUTCFullYear(1991);
    exposedUpdatedAt.setUTCFullYear(1991);

    expect(wallet.createdAt).toEqual(
      new Date('2026-09-03T10:00:00.000Z'),
    );
    expect(wallet.updatedAt).toEqual(
      new Date('2026-09-03T10:01:00.000Z'),
    );
  });

  test('rehydrates the persisted state exactly without replaying transitions', () => {
    const createdAt = new Date('2026-08-01T09:00:00.000Z');
    const updatedAt = new Date('2026-09-01T12:00:00.000Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-persisted',
      playerId: 'player-persisted',
      currency: 'BRL',
      balance: money('250.00'),
      version: 7,
      createdAt,
      updatedAt,
    });

    createdAt.setUTCFullYear(1990);
    updatedAt.setUTCFullYear(1990);

    expect(wallet.id).toBe('wallet-persisted');
    expect(wallet.playerId).toBe('player-persisted');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON().amount).toBe('250.00');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(
      new Date('2026-08-01T09:00:00.000Z'),
    );
    expect(wallet.updatedAt).toEqual(
      new Date('2026-09-01T12:00:00.000Z'),
    );
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid rehydrated version: %p',
    (version) => {
      expect(() =>
        Wallet.rehydrate({
          id: 'wallet-persisted',
          playerId: 'player-persisted',
          currency: 'BRL',
          balance: money('250.00'),
          version,
          createdAt: openedAt,
          updatedAt: openedAt,
        }),
      ).toThrow(InvalidWalletVersionError);
    },
  );

  test('rejects a rehydrated currency inconsistent with the balance', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-persisted',
        playerId: 'player-persisted',
        currency: 'USD',
        balance: money('250.00', 'BRL'),
        version: 7,
        createdAt: openedAt,
        updatedAt: openedAt,
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('rejects a negative rehydrated balance', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'wallet-persisted',
        playerId: 'player-persisted',
        currency: 'BRL',
        balance: money('0.01').negate(),
        version: 7,
        createdAt: openedAt,
        updatedAt: openedAt,
      }),
    ).toThrow(InvalidWalletBalanceError);
  });
});
