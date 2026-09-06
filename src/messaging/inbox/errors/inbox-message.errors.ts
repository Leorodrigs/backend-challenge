export type InboxMessageField =
  | 'messageId'
  | 'consumerName'
  | 'payloadHash'
  | 'receivedAt'
  | 'processedAt';

export class InvalidInboxMessageError extends Error {
  constructor(public readonly field: InboxMessageField) {
    super(`Invalid inbox message ${field}`);
    this.name = 'InvalidInboxMessageError';
  }
}

export class InboxMessageAlreadyProcessedError extends Error {
  constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
  ) {
    super('The inbox message is already processed');
    this.name = 'InboxMessageAlreadyProcessedError';
  }
}

export class InboxPayloadConflictError extends Error {
  constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
  ) {
    super('The logical inbox message is already associated with a different payload');
    this.name = 'InboxPayloadConflictError';
  }
}
