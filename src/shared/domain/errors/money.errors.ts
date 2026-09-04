export class InvalidMoneyAmountError extends Error {
  constructor() {
    super('Invalid money amount');
    this.name = 'InvalidMoneyAmountError';
  }
}

export class InvalidCurrencyError extends Error {
  constructor(public readonly currency: unknown) {
    super(`Invalid currency: ${String(currency)}`);
    this.name = 'InvalidCurrencyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(
    public readonly expectedCurrency: string,
    public readonly actualCurrency: string,
  ) {
    super(
      `Currency mismatch: expected ${expectedCurrency}, received ${actualCurrency}`,
    );
    this.name = 'CurrencyMismatchError';
  }
}
