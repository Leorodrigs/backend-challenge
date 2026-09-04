import { Money } from '../../shared/domain/value-objects/money.js';
import { InvalidLedgerEntryError } from './errors/wallet-ledger-entry.errors.js';
import { LedgerDirection } from './ledger-direction.js';

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create({
    id,
    walletId,
    transactionId,
    direction,
    money,
    balanceBefore,
    balanceAfter,
    createdAt = new Date(),
  }: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertValidIdentifiers(id, walletId, transactionId);
    WalletLedgerEntry.assertValidMoney(
      money,
      balanceBefore,
      balanceAfter,
    );
    const creationDate = WalletLedgerEntry.copyValidDate(createdAt);
    const entry = new WalletLedgerEntry(
      id,
      walletId,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      creationDate,
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('UNBALANCED');
    }

    return entry;
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    WalletLedgerEntry.assertValidIdentifiers(
      state.id,
      state.walletId,
      state.transactionId,
    );
    WalletLedgerEntry.assertValidMoney(
      state.money,
      state.balanceBefore,
      state.balanceAfter,
    );

    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      WalletLedgerEntry.copyValidDate(state.createdAt),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    const expectedBalance =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }

  private static assertValidIdentifiers(
    id: unknown,
    walletId: unknown,
    transactionId: unknown,
  ): void {
    if (
      !WalletLedgerEntry.isValidIdentifier(id) ||
      !WalletLedgerEntry.isValidIdentifier(walletId) ||
      !WalletLedgerEntry.isValidIdentifier(transactionId)
    ) {
      throw new InvalidLedgerEntryError('INVALID_IDENTIFIER');
    }
  }

  private static isValidIdentifier(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.trim() === value
    );
  }

  private static assertValidMoney(
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
  ): void {
    if (
      !(money instanceof Money) ||
      !(balanceBefore instanceof Money) ||
      !(balanceAfter instanceof Money)
    ) {
      throw new InvalidLedgerEntryError('INVALID_MONEY');
    }

    if (
      money.currency !== balanceBefore.currency ||
      money.currency !== balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError('CURRENCY_MISMATCH');
    }

    if (money.isNegative()) {
      throw new InvalidLedgerEntryError('NEGATIVE_AMOUNT');
    }

    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('NEGATIVE_BALANCE');
    }
  }

  private static copyValidDate(date: Date): Date {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new InvalidLedgerEntryError('INVALID_DATE');
    }

    return new Date(date.getTime());
  }
}
