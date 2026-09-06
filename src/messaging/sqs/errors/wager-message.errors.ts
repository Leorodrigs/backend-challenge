export type WagerMessageField =
  | 'body'
  | 'json'
  | 'messageId'
  | 'type'
  | 'occurredAt'
  | 'data'
  | 'providerId'
  | 'externalTransactionId'
  | 'idempotencyKey'
  | 'playerId'
  | 'walletId'
  | 'roundId'
  | 'gameId'
  | 'kind'
  | 'money'
  | 'referenceExternalTransactionId';

export class InvalidWagerTransactionMessageError extends Error {
  constructor(
    public readonly field: WagerMessageField,
    options?: ErrorOptions,
  ) {
    super(`Invalid WagerTransactionRequested message ${field}`, options);
    this.name = 'InvalidWagerTransactionMessageError';
  }
}
