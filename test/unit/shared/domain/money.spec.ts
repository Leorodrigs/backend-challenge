import { describe, expect, test } from 'bun:test';

import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from '../../../../src/shared/domain/errors/money.errors.js';
import { Money } from '../../../../src/shared/domain/value-objects/money.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

describe('Money', () => {
  test.each(['0.00', '25.00', '1000.50'])(
    'creates a valid fixed-scale amount: %s BRL',
    (amount) => {
      const value = money(amount);

      expect(value.toJSON()).toEqual({ amount, currency: 'BRL' });
      expect(value.toString()).toBe(`${amount} BRL`);
    },
  );

  test('creates zero with two decimal places', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
  });

  test.each([
    '',
    ' ',
    'abc',
    'NaN',
    'Infinity',
    '-Infinity',
    '25',
    '25.',
    '25.0',
    '25.000',
    '0.001',
    '1,00',
    '1e3',
    '1E3',
    '.50',
    '--10.00',
    '01.00',
  ])('rejects an invalid external amount: %p', (amount) => {
    expect(() => money(amount)).toThrow(InvalidMoneyAmountError);
  });

  test('rejects a negative external amount but permits negative arithmetic results', () => {
    expect(() => money('-25.00')).toThrow(InvalidMoneyAmountError);

    const negative = money('25.00').negate();

    expect(negative.toJSON()).toEqual({
      amount: '-25.00',
      currency: 'BRL',
    });
    expect(negative.isNegative()).toBe(true);
  });

  test.each(['', 'BR', 'BRLL', 'brl', '12A', ' BRL '])(
    'rejects a structurally invalid currency: %p',
    (currency) => {
      expect(() => money('25.00', currency)).toThrow(InvalidCurrencyError);
      expect(() => Money.zero(currency)).toThrow(InvalidCurrencyError);
    },
  );

  test('adds values without changing either operand', () => {
    const left = money('10.00');
    const right = money('15.00');

    const result = left.add(right);

    expect(result.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(left.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(right.toJSON()).toEqual({ amount: '15.00', currency: 'BRL' });
  });

  test('accepts the maximum NUMERIC(20,2) amount', () => {
    expect(money('999999999999999999.99').toJSON()).toEqual({
      amount: '999999999999999999.99',
      currency: 'BRL',
    });
  });

  test('rejects nineteen integer digits without exposing the amount in the error', () => {
    let caught: unknown;

    try {
      money('1000000000000000000.00');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidMoneyAmountError);
    expect((caught as Error).message).toBe('Invalid money amount');
    expect(caught).not.toHaveProperty('amount');
  });

  test('keeps cents exact when adding near the NUMERIC(20,2) limit', () => {
    const result = money('999999999999999999.98').add(money('0.01'));

    expect(result.toJSON()).toEqual({
      amount: '999999999999999999.99',
      currency: 'BRL',
    });
  });

  test('rejects an arithmetic result outside NUMERIC(20,2)', () => {
    expect(() =>
      money('999999999999999999.99').add(money('0.01')),
    ).toThrow(InvalidMoneyAmountError);
  });

  test('subtracts values without changing either operand', () => {
    const original = money('100.00');
    const deduction = money('25.00');

    const result = original.subtract(deduction);

    expect(result.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(original.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(deduction.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test('represents a negative subtraction result', () => {
    expect(money('10.00').subtract(money('25.00')).toJSON()).toEqual({
      amount: '-15.00',
      currency: 'BRL',
    });
  });

  test('negates without changing the original value', () => {
    const original = money('25.00');
    const negative = original.negate();

    expect(original.toString()).toBe('25.00 BRL');
    expect(negative.toString()).toBe('-25.00 BRL');
    expect(negative.negate().toString()).toBe('25.00 BRL');
  });

  test('normalizes negative zero', () => {
    const result = Money.zero('BRL').negate();

    expect(result.toJSON().amount).toBe('0.00');
    expect(result.isZero()).toBe(true);
    expect(result.isPositive()).toBe(false);
    expect(result.isNegative()).toBe(false);
  });

  test('compares zero, positive, negative, and ordered values', () => {
    const zero = money('0.00');
    const lower = money('10.00');
    const higher = money('25.00');
    const negative = lower.negate();

    expect(zero.isZero()).toBe(true);
    expect(lower.isPositive()).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(lower.isLessThan(higher)).toBe(true);
    expect(higher.isLessThan(lower)).toBe(false);
    expect(lower.equals(money('10.00'))).toBe(true);
    expect(lower.equals(higher)).toBe(false);
  });

  test('rejects arithmetic and ordering across currencies', () => {
    const brl = money('25.00', 'BRL');
    const usd = money('25.00', 'USD');

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('considers otherwise equal values in different currencies unequal', () => {
    expect(money('25.00', 'BRL').equals(money('25.00', 'USD'))).toBe(false);
  });
});
