import type { OutboxMessage } from '../domain/outbox-message.js';

export abstract class IntegrationEventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}
