import { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper.js';

@Injectable()
export class MikroOrmWalletLedgerEntryRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async findById(id: string): Promise<WalletLedgerEntry | undefined> {
    const entity = await this.entityManager.findOne(
      WalletLedgerEntryEntity,
      { id },
    );
    return entity === null
      ? undefined
      : WalletLedgerEntryMapper.toDomain(entity);
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    this.entityManager.persist(WalletLedgerEntryMapper.toPersistence(entry));
    await this.entityManager.flush();
  }
}
