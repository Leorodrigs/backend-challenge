import { InboxMessage } from '../../../messaging/inbox/domain/inbox-message.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';

export class InboxMessageMapper {
  static toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      ...(entity.processedAt === null
        ? {}
        : { processedAt: entity.processedAt }),
    });
  }

  static toPersistence(
    message: InboxMessage,
    target = new InboxMessageEntity(),
  ): InboxMessageEntity {
    target.consumerName = message.consumerName;
    target.messageId = message.messageId;
    target.payloadHash = message.payloadHash;
    target.receivedAt = message.receivedAt;
    target.processedAt = message.processedAt ?? null;
    return target;
  }
}
