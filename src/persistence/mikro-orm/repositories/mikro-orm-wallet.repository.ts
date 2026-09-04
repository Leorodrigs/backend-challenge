import { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import { Wallet } from '../../../wallet/domain/wallet.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WalletMapper } from '../mappers/wallet.mapper.js';

@Injectable()
export class MikroOrmWalletRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const entity = await this.entityManager.findOne(WalletEntity, { id });
    return entity === null ? undefined : WalletMapper.toDomain(entity);
  }

  async save(wallet: Wallet): Promise<void> {
    const existing = await this.entityManager.findOne(WalletEntity, {
      id: wallet.id,
    });
    const entity = WalletMapper.toPersistence(
      wallet,
      existing ?? new WalletEntity(),
    );

    this.entityManager.persist(entity);
    await this.entityManager.flush();
  }
}
