export class UnsupportedWagerTransactionKindError extends Error {
  constructor(public readonly kind: unknown) {
    super('Only BET, WIN, LOSS, REFUND and ROLLBACK are supported by this processing flow');
    this.name = 'UnsupportedWagerTransactionKindError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super('Wallet not found');
    this.name = 'WalletNotFoundError';
  }
}

export class WalletPlayerMismatchError extends Error {
  constructor(public readonly walletId: string) {
    super('The transaction player does not own the wallet');
    this.name = 'WalletPlayerMismatchError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super('The idempotency key is already associated with a different business payload');
    this.name = 'IdempotencyConflictError';
  }
}

export class ExternalTransactionConflictError extends Error {
  constructor(public readonly providerId: string, public readonly externalTransactionId: string) {
    super('The external operation is already associated with another idempotency key');
    this.name = 'ExternalTransactionConflictError';
  }
}

export class WagerClaimConflictError extends Error {
  constructor() {
    super('The claim collided with a structural key without a matching logical operation');
    this.name = 'WagerClaimConflictError';
  }
}

export class WagerResultUnavailableError extends Error {
  constructor(public readonly transactionId: string, public readonly status: string) {
    super('The stored operation has no historical result snapshot');
    this.name = 'WagerResultUnavailableError';
  }
}
