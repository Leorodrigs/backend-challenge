import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';

import {
  canonicalizeJson,
  type JsonValue,
} from '../../../wagering/application/canonical-json.js';
import type { IntegrationEventPublisher } from '../application/integration-event.publisher.js';
import type { OutboxMessage } from '../domain/outbox-message.js';

export class SnsIntegrationEventPublisher implements IntegrationEventPublisher {
  constructor(
    private readonly snsClient: SNSClient,
    private readonly topicArn: string,
  ) {
    if (topicArn.trim() === '') {
      throw new TypeError('SNS integration events TopicArn must be non-empty');
    }
  }

  async publish(message: OutboxMessage): Promise<void> {
    const correlationId = message.payload.correlationId;
    await this.snsClient.send(new PublishCommand({
      TopicArn: this.topicArn,
      Message: canonicalizeJson(message.payload as unknown as JsonValue),
      MessageAttributes: {
        eventId: { DataType: 'String', StringValue: message.id },
        eventType: { DataType: 'String', StringValue: message.eventType },
        aggregateId: { DataType: 'String', StringValue: message.aggregateId },
        ...(typeof correlationId !== 'string'
          ? {}
          : {
              correlationId: {
                DataType: 'String',
                StringValue: correlationId,
              },
            }),
      },
    }));
  }
}
