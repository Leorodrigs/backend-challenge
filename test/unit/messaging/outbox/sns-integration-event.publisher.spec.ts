import { describe, expect, mock, test } from 'bun:test';
import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';

import { SnsIntegrationEventPublisher } from '../../../../src/messaging/outbox/infrastructure/sns-integration-event.publisher.js';
import { OutboxMessage } from '../../../../src/messaging/outbox/domain/outbox-message.js';

describe('SnsIntegrationEventPublisher', () => {
  test('publishes the persisted envelope canonically with non-financial attributes', async () => {
    const send = mock(async (_command: unknown) => ({ MessageId: 'sns-message' }));
    const publisher = new SnsIntegrationEventPublisher(
      { send } as unknown as SNSClient,
      'arn:aws:sns:us-east-1:000000000000:wager-integration-events',
    );
    const message = OutboxMessage.rehydrate({
      id: 'event-1', aggregateId: 'transaction-1', eventType: 'WagerTransactionProcessed',
      occurredAt: new Date('2026-09-06T12:00:00.000Z'), attempts: 0,
      nextAttemptAt: new Date('2026-09-06T12:00:00.000Z'), publishedAt: undefined,
      payload: {
        version: 1, occurredAt: '2026-09-06T12:00:00.000Z', correlationId: 'transaction-1',
        aggregateId: 'transaction-1', eventType: 'WagerTransactionProcessed', eventId: 'event-1',
        data: { money: { currency: 'BRL', amount: '25.00' } },
      },
    });

    await publisher.publish(message);

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PublishCommand);
    expect((command as PublishCommand).input).toEqual({
      TopicArn: 'arn:aws:sns:us-east-1:000000000000:wager-integration-events',
      Message: '{"aggregateId":"transaction-1","correlationId":"transaction-1","data":{"money":{"amount":"25.00","currency":"BRL"}},"eventId":"event-1","eventType":"WagerTransactionProcessed","occurredAt":"2026-09-06T12:00:00.000Z","version":1}',
      MessageAttributes: {
        eventId: { DataType: 'String', StringValue: 'event-1' },
        eventType: { DataType: 'String', StringValue: 'WagerTransactionProcessed' },
        aggregateId: { DataType: 'String', StringValue: 'transaction-1' },
        correlationId: { DataType: 'String', StringValue: 'transaction-1' },
      },
    });
  });
});
