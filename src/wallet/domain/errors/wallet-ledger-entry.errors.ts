export type InvalidLedgerEntryReason =
  | 'INVALID_IDENTIFIER'
  | 'INVALID_MONEY'
  | 'NEGATIVE_AMOUNT'
  | 'NEGATIVE_BALANCE'
  | 'CURRENCY_MISMATCH'
  | 'UNBALANCED'
  | 'INVALID_DATE';

export class InvalidLedgerEntryError extends Error {
  constructor(public readonly reason: InvalidLedgerEntryReason) {
    super(`Invalid wallet ledger entry: ${reason}`);
    this.name = 'InvalidLedgerEntryError';
  }
}
