import { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import { WagerTransaction } from '../../../wagering/domain/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper.js';

@Injectable()
export class MikroOrmWagerTransactionRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, {
      id,
    });
    return entity === null
      ? undefined
      : WagerTransactionMapper.toDomain(entity);
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const existing = await this.entityManager.findOne(
      WagerTransactionEntity,
      { id: transaction.id },
    );
    const entity = WagerTransactionMapper.toPersistence(
      transaction,
      existing ?? new WagerTransactionEntity(),
    );

    this.entityManager.persist(entity);
    await this.entityManager.flush();
  }
}
