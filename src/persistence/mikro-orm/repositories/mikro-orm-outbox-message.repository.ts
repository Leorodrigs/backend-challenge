import type { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import type { OutboxMessage } from '../../../messaging/outbox/domain/outbox-message.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper.js';

@Injectable()
export class MikroOrmOutboxMessageRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async append(message: OutboxMessage): Promise<void> {
    this.assertTransaction();
    this.entityManager.persist(OutboxMessageMapper.toPersistence(message));
    await this.entityManager.flush();
  }

  async claimNextDue(now: Date): Promise<OutboxMessage | undefined> {
    this.assertTransaction();
    const rows = await this.entityManager.execute<Array<{ id: string }>>(
      `select id
       from outbox_messages
       where published_at is null and next_attempt_at <= ?
       order by next_attempt_at, occurred_at, id
       limit 1
       for update skip locked`,
      [now],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const entity = await this.entityManager.findOneOrFail(
      OutboxMessageEntity,
      { id: row.id },
      { refresh: true },
    );
    return OutboxMessageMapper.toDomain(entity);
  }

  async save(message: OutboxMessage): Promise<void> {
    this.assertTransaction();
    const entity = await this.entityManager.findOneOrFail(
      OutboxMessageEntity,
      { id: message.id },
    );
    OutboxMessageMapper.toPersistence(message, entity);
    await this.entityManager.flush();
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const entity = await this.entityManager.findOne(
      OutboxMessageEntity,
      { id },
      { refresh: true },
    );
    return entity === null ? undefined : OutboxMessageMapper.toDomain(entity);
  }

  private assertTransaction(): void {
    if (!this.entityManager.isInTransaction()) {
      throw new Error('An open transaction is required for Outbox operations');
    }
  }
}
