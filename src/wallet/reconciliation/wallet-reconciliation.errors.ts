export class ReconciliationWalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super('Wallet not found');
    this.name = 'ReconciliationWalletNotFoundError';
  }
}

export class LedgerCurrencyIntegrityError extends Error {
  constructor(
    public readonly walletId: string,
    public readonly walletCurrency: string,
  ) {
    super('The wallet ledger contains entries in an incompatible currency');
    this.name = 'LedgerCurrencyIntegrityError';
  }
}
