import { Decimal } from 'decimal.js';

import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from '../errors/money.errors.js';

const MONEY_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MoneyDecimal = Decimal.clone({ precision: 40 });
const ZERO = new MoneyDecimal('0.00');
const MAX_ABSOLUTE_AMOUNT = new MoneyDecimal('999999999999999999.99');

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);

    if (
      typeof props.amount !== 'string' ||
      !MONEY_AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new InvalidMoneyAmountError();
    }

    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(ZERO, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromValidatedDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromValidatedDecimal(
      this.value.minus(other.value),
      this.currency,
    );
  }

  negate(): Money {
    return Money.fromValidatedDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return !this.value.isZero() && this.value.isPositive();
  }

  isNegative(): boolean {
    return !this.value.isZero() && this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private static fromValidatedDecimal(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(MAX_ABSOLUTE_AMOUNT)) {
      throw new InvalidMoneyAmountError();
    }

    return new Money(value.isZero() ? ZERO : value, currency);
  }

  private static assertValidCurrency(
    currency: unknown,
  ): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError(currency);
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
