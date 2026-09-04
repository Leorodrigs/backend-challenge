import { describe, expect, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import { InvalidLedgerEntryError } from '../../../../src/wallet/domain/errors/wallet-ledger-entry.errors.js';
import { LedgerDirection } from '../../../../src/wallet/domain/ledger-direction.js';
import { WalletLedgerEntry } from '../../../../src/wallet/domain/wallet-ledger-entry.js';

const createdAt = new Date('2026-09-04T11:00:00.000Z');
const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

function createEntry(
  direction: LedgerDirection,
  amount: Money,
  balanceBefore: Money,
  balanceAfter: Money,
): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: 'ledger-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction,
    money: amount,
    balanceBefore,
    balanceAfter,
    createdAt,
  });
}

describe('WalletLedgerEntry', () => {
  test('creates a balanced CREDIT entry', () => {
    const entry = createEntry(
      LedgerDirection.Credit,
      money('25.00'),
      money('100.00'),
      money('125.00'),
    );

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test('creates a balanced DEBIT entry', () => {
    const entry = createEntry(
      LedgerDirection.Debit,
      money('25.00'),
      money('100.00'),
      money('75.00'),
    );

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    [LedgerDirection.Credit, '124.99'],
    [LedgerDirection.Debit, '75.01'],
  ] as const)('rejects an unbalanced %s entry', (direction, balanceAfter) => {
    expect(() =>
      createEntry(
        direction,
        money('25.00'),
        money('100.00'),
        money(balanceAfter),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects inconsistent currencies', () => {
    expect(() =>
      createEntry(
        LedgerDirection.Credit,
        money('25.00', 'BRL'),
        money('100.00', 'BRL'),
        money('125.00', 'USD'),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative balanceAfter', () => {
    expect(() =>
      createEntry(
        LedgerDirection.Debit,
        money('1.00'),
        Money.zero('BRL'),
        money('1.00').negate(),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative balanceBefore and a negative amount', () => {
    expect(() =>
      createEntry(
        LedgerDirection.Credit,
        money('1.00'),
        money('1.00').negate(),
        Money.zero('BRL'),
      ),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      createEntry(
        LedgerDirection.Debit,
        money('1.00').negate(),
        money('10.00'),
        money('11.00'),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rehydrates and preserves the persisted immutable state', () => {
    const inputDate = new Date(createdAt.getTime());
    const entry = WalletLedgerEntry.rehydrate({
      id: 'ledger-persisted',
      walletId: 'wallet-persisted',
      transactionId: 'transaction-persisted',
      direction: LedgerDirection.Debit,
      money: money('10.00'),
      balanceBefore: money('50.00'),
      balanceAfter: money('40.00'),
      createdAt: inputDate,
    });

    inputDate.setUTCFullYear(1990);
    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(1991);

    expect(entry.id).toBe('ledger-persisted');
    expect(entry.walletId).toBe('wallet-persisted');
    expect(entry.transactionId).toBe('transaction-persisted');
    expect(entry.money.toJSON().amount).toBe('10.00');
    expect(entry.balanceBefore.toJSON().amount).toBe('50.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('40.00');
    expect(entry.createdAt).toEqual(createdAt);
    expect(entry.isBalanced()).toBe(true);
  });
});
