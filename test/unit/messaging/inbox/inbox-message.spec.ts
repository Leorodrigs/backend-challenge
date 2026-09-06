import { describe, expect, test } from 'bun:test';

import { InboxMessage } from '../../../../src/messaging/inbox/domain/inbox-message.js';
import {
  InboxMessageAlreadyProcessedError,
  InvalidInboxMessageError,
} from '../../../../src/messaging/inbox/errors/inbox-message.errors.js';

const hash = 'a'.repeat(64);
const receivedAt = new Date('2026-09-05T12:00:00.000Z');

describe('InboxMessage', () => {
  test('receives, marks processed and defensively copies dates', () => {
    const message = InboxMessage.receive({
      consumerName: 'wager-transactions-v1',
      messageId: 'msg-1',
      payloadHash: hash,
      receivedAt,
    });

    expect(message.isProcessed()).toBe(false);
    const processedAt = new Date('2026-09-05T12:00:01.000Z');
    message.markProcessed(processedAt);
    processedAt.setUTCFullYear(2000);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe(
      '2026-09-05T12:00:01.000Z',
    );
    expect(() => message.markProcessed(new Date())).toThrow(
      InboxMessageAlreadyProcessedError,
    );
  });

  test.each([
    [{ messageId: '', consumerName: 'consumer', payloadHash: hash, receivedAt }, 'messageId'],
    [{ messageId: 'msg', consumerName: ' consumer', payloadHash: hash, receivedAt }, 'consumerName'],
    [{ messageId: 'msg', consumerName: 'consumer', payloadHash: 'ABC', receivedAt }, 'payloadHash'],
    [{ messageId: 'msg', consumerName: 'consumer', payloadHash: hash, receivedAt: new Date('invalid') }, 'receivedAt'],
  ] as const)('rejects invalid receive state for %s', (state, field) => {
    expect(() => InboxMessage.receive(state)).toThrow(
      new InvalidInboxMessageError(field),
    );
  });

  test('rejects processedAt before receivedAt in transition and rehydration', () => {
    const message = InboxMessage.receive({
      consumerName: 'consumer',
      messageId: 'msg',
      payloadHash: hash,
      receivedAt,
    });
    const before = new Date(receivedAt.getTime() - 1);

    expect(() => message.markProcessed(before)).toThrow(
      InvalidInboxMessageError,
    );
    expect(() =>
      InboxMessage.rehydrate({
        consumerName: 'consumer',
        messageId: 'msg',
        payloadHash: hash,
        receivedAt,
        processedAt: before,
      }),
    ).toThrow(InvalidInboxMessageError);
  });
});
