export class UnsupportedWagerTransactionKindError extends Error {
  constructor(public readonly kind: unknown) {
    super('Only BET, WIN and LOSS are supported by this processing flow');
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
