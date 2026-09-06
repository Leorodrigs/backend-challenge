import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { InboxMessage } from '../../../messaging/inbox/domain/inbox-message.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';
import { InboxMessageMapper } from '../mappers/inbox-message.mapper.js';

export class MikroOrmInboxMessageRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    this.assertTransaction();
    const entity = InboxMessageMapper.toPersistence(message);
    const rows = await this.entityManager.execute<Array<{ message_id: string }>>(
      `insert into inbox_messages (
        consumer_name, message_id, payload_hash, received_at, processed_at
      ) values (?, ?, ?, ?, ?)
      on conflict (consumer_name, message_id) do nothing
      returning message_id`,
      [
        entity.consumerName,
        entity.messageId,
        entity.payloadHash,
        entity.receivedAt,
        entity.processedAt,
      ],
    );
    return rows.length === 1;
  }

  async findForUpdate(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    this.assertTransaction();
    const entity = await this.entityManager.findOne(
      InboxMessageEntity,
      { consumerName, messageId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return entity === null ? undefined : InboxMessageMapper.toDomain(entity);
  }

  async save(message: InboxMessage): Promise<void> {
    this.assertTransaction();
    const entity = await this.entityManager.findOneOrFail(
      InboxMessageEntity,
      {
        consumerName: message.consumerName,
        messageId: message.messageId,
      },
    );
    InboxMessageMapper.toPersistence(message, entity);
    await this.entityManager.flush();
  }

  private assertTransaction(): void {
    if (!this.entityManager.isInTransaction()) {
      throw new Error('An open transaction is required for Inbox operations');
    }
  }
}
