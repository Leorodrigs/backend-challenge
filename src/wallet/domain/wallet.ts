import { CurrencyMismatchError } from '../../shared/domain/errors/money.errors.js';
import { Money } from '../../shared/domain/value-objects/money.js';
import {
  InsufficientFundsError,
  InvalidWalletAmountError,
  InvalidWalletBalanceError,
  InvalidWalletDateError,
  InvalidWalletIdentifierError,
  InvalidWalletVersionError,
  type WalletIdentifierField,
  type WalletOperation,
} from './errors/wallet.errors.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletBalanceChange {
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly versionBefore: number;
  readonly versionAfter: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open({
    id,
    playerId,
    initialBalance,
    openedAt = new Date(),
  }: OpenWalletProps): Wallet {
    Wallet.assertValidIdentifier(id, 'id');
    Wallet.assertValidIdentifier(playerId, 'playerId');
    Wallet.assertValidBalance(initialBalance);

    const creationDate = Wallet.copyValidDate(openedAt, 'createdAt');

    return new Wallet(
      id,
      playerId,
      initialBalance.currency,
      initialBalance,
      1,
      creationDate,
      new Date(creationDate.getTime()),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    Wallet.assertValidIdentifier(state.id, 'id');
    Wallet.assertValidIdentifier(state.playerId, 'playerId');
    Wallet.assertValidBalance(state.balance);

    if (state.currency !== state.balance.currency) {
      throw new CurrencyMismatchError(
        state.currency,
        state.balance.currency,
      );
    }

    Wallet.assertValidVersion(state.version);
    const createdAt = Wallet.copyValidDate(state.createdAt, 'createdAt');
    const updatedAt = Wallet.copyValidDate(state.updatedAt, 'updatedAt');

    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      createdAt,
      updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  credit(money: Money, at: Date): WalletBalanceChange | undefined {
    this.assertApplicableMoney(money, 'credit');

    if (money.isZero()) {
      return undefined;
    }

    const changeDate = Wallet.copyValidDate(at, 'at');
    const balanceAfter = this._balance.add(money);

    return this.applyBalanceChange(balanceAfter, changeDate);
  }

  debit(money: Money, at: Date): WalletBalanceChange | undefined {
    this.assertApplicableMoney(money, 'debit');

    if (money.isZero()) {
      return undefined;
    }

    const changeDate = Wallet.copyValidDate(at, 'at');

    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError();
    }

    const balanceAfter = this._balance.subtract(money);
    return this.applyBalanceChange(balanceAfter, changeDate);
  }

  private applyBalanceChange(
    balanceAfter: Money,
    changedAt: Date,
  ): WalletBalanceChange {
    const versionAfter = this._version + 1;
    Wallet.assertValidVersion(versionAfter);

    const change = Object.freeze({
      balanceBefore: this._balance,
      balanceAfter,
      versionBefore: this._version,
      versionAfter,
    });

    this._balance = balanceAfter;
    this._version = versionAfter;
    this._updatedAt = changedAt;

    return change;
  }

  private assertApplicableMoney(
    money: Money,
    operation: WalletOperation,
  ): void {
    Wallet.assertValidBalanceInstance(money);

    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }

    if (money.isNegative()) {
      throw new InvalidWalletAmountError(operation);
    }
  }

  private static assertValidIdentifier(
    value: unknown,
    field: WalletIdentifierField,
  ): asserts value is string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value
    ) {
      throw new InvalidWalletIdentifierError(field, value);
    }
  }

  private static assertValidBalance(balance: Money): void {
    Wallet.assertValidBalanceInstance(balance);

    if (balance.isNegative()) {
      throw new InvalidWalletBalanceError();
    }
  }

  private static assertValidBalanceInstance(
    balance: Money,
  ): asserts balance is Money {
    if (!(balance instanceof Money)) {
      throw new InvalidWalletBalanceError();
    }
  }

  private static assertValidVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new InvalidWalletVersionError(version);
    }
  }

  private static copyValidDate(
    date: Date,
    field: 'createdAt' | 'updatedAt' | 'at',
  ): Date {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new InvalidWalletDateError(field);
    }

    return new Date(date.getTime());
  }
}
