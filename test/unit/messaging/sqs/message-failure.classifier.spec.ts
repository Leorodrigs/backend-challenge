import { describe, expect, test } from 'bun:test';

import { InboxPayloadConflictError } from '../../../../src/messaging/inbox/errors/inbox-message.errors.js';
import { InvalidWagerTransactionMessageError } from '../../../../src/messaging/sqs/errors/wager-message.errors.js';
import {
  MessageFailureAction,
  MessageFailureClassifier,
} from '../../../../src/messaging/sqs/message-failure.classifier.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
  WagerResultUnavailableError,
} from '../../../../src/wagering/application/errors/wager-processing.errors.js';

describe('MessageFailureClassifier', () => {
  const classifier = new MessageFailureClassifier();

  test.each([
    new IdempotencyConflictError('key'),
    new ExternalTransactionConflictError('provider', 'external'),
  ])('classifies business conflict as terminal ACK', (error) => {
    expect(classifier.classify(error)).toBe(MessageFailureAction.TerminalAck);
  });

  test.each([
    new InvalidWagerTransactionMessageError('json'),
    new InboxPayloadConflictError('consumer', 'msg'),
    new WalletNotFoundError('wallet'),
    new WalletPlayerMismatchError('wallet'),
    new WagerResultUnavailableError('transaction', 'FAILED'),
  ])('classifies permanent failure for immediate DLQ', (error) => {
    expect(classifier.classify(error)).toBe(MessageFailureAction.Dlq);
  });

  test('defaults unknown/infrastructure failures to retry', () => {
    expect(classifier.classify(new Error('connection reset'))).toBe(
      MessageFailureAction.Retry,
    );
  });
});
