import { OutboxMessage } from '../../../messaging/outbox/domain/outbox-message.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';

export class OutboxMessageMapper {
  static toDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      payload: entity.payload,
      occurredAt: entity.occurredAt,
      attempts: entity.attempts,
      nextAttemptAt: entity.nextAttemptAt ?? undefined,
      publishedAt: entity.publishedAt ?? undefined,
    });
  }

  static toPersistence(
    message: OutboxMessage,
    target = new OutboxMessageEntity(),
  ): OutboxMessageEntity {
    target.id = message.id;
    target.aggregateId = message.aggregateId;
    target.eventType = message.eventType;
    target.payload = message.payload as Record<string, unknown>;
    target.occurredAt = message.occurredAt;
    target.attempts = message.attempts;
    target.nextAttemptAt = message.nextAttemptAt ?? null;
    target.publishedAt = message.publishedAt ?? null;
    return target;
  }
}
