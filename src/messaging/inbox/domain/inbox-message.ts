import {
  InboxMessageAlreadyProcessedError,
  InvalidInboxMessageError,
  type InboxMessageField,
} from '../errors/inbox-message.errors.js';

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface ReceiveInboxMessageProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive({
    messageId,
    consumerName,
    payloadHash,
    receivedAt = new Date(),
  }: ReceiveInboxMessageProps): InboxMessage {
    return InboxMessage.fromState({
      messageId,
      consumerName,
      payloadHash,
      receivedAt,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return InboxMessage.fromState(state);
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt.getTime());
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined
      ? undefined
      : new Date(this._processedAt.getTime());
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxMessageAlreadyProcessedError(
        this.consumerName,
        this.messageId,
      );
    }

    const processedAt = InboxMessage.copyValidDate(at, 'processedAt');
    if (processedAt.getTime() < this._receivedAt.getTime()) {
      throw new InvalidInboxMessageError('processedAt');
    }
    this._processedAt = processedAt;
  }

  private static fromState(state: InboxMessageState): InboxMessage {
    InboxMessage.assertIdentifier(state.messageId, 'messageId');
    InboxMessage.assertIdentifier(state.consumerName, 'consumerName');
    if (
      typeof state.payloadHash !== 'string' ||
      !SHA_256_HEX_PATTERN.test(state.payloadHash)
    ) {
      throw new InvalidInboxMessageError('payloadHash');
    }

    const receivedAt = InboxMessage.copyValidDate(
      state.receivedAt,
      'receivedAt',
    );
    const processedAt =
      state.processedAt === undefined
        ? undefined
        : InboxMessage.copyValidDate(state.processedAt, 'processedAt');
    if (
      processedAt !== undefined &&
      processedAt.getTime() < receivedAt.getTime()
    ) {
      throw new InvalidInboxMessageError('processedAt');
    }

    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      receivedAt,
      processedAt,
    );
  }

  private static assertIdentifier(
    value: unknown,
    field: Extract<InboxMessageField, 'messageId' | 'consumerName'>,
  ): asserts value is string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value
    ) {
      throw new InvalidInboxMessageError(field);
    }
  }

  private static copyValidDate(
    value: Date,
    field: Extract<InboxMessageField, 'receivedAt' | 'processedAt'>,
  ): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidInboxMessageError(field);
    }
    return new Date(value.getTime());
  }
}
