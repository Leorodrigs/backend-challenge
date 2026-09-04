export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  ReversalWouldMakeBalanceNegative =
    'REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}
