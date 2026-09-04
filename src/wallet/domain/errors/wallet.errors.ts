export type WalletIdentifierField = 'id' | 'playerId';
export type WalletOperation = 'credit' | 'debit';

export class InvalidWalletIdentifierError extends Error {
  constructor(
    public readonly field: WalletIdentifierField,
    public readonly value: unknown,
  ) {
    super(`Wallet ${field} must be a non-empty, unpadded string`);
    this.name = 'InvalidWalletIdentifierError';
  }
}

export class InvalidWalletBalanceError extends Error {
  constructor() {
    super('Wallet balance must be valid and non-negative');
    this.name = 'InvalidWalletBalanceError';
  }
}

export class InvalidWalletAmountError extends Error {
  constructor(public readonly operation: WalletOperation) {
    super(`Wallet ${operation} amount must not be negative`);
    this.name = 'InvalidWalletAmountError';
  }
}

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidWalletVersionError extends Error {
  constructor(public readonly version: number) {
    super(`Wallet version must be a positive safe integer: ${version}`);
    this.name = 'InvalidWalletVersionError';
  }
}

export class InvalidWalletDateError extends Error {
  constructor(public readonly field: 'createdAt' | 'updatedAt' | 'at') {
    super(`Wallet ${field} must be a valid Date`);
    this.name = 'InvalidWalletDateError';
  }
}
