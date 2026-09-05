import { EntityManager, raw } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper.js';

@Injectable()
export class MikroOrmWalletLedgerEntryRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async findByWalletAndTransactionId(walletId: string, transactionId: string): Promise<WalletLedgerEntry | undefined> {
    // The mapped relation has a composite FK (transaction_id, wallet_id).
    // Compare its scalar column explicitly; a scalar relation filter means a tuple to the ORM.
    const entity = await this.entityManager.findOne(WalletLedgerEntryEntity, {
      walletId,
      [raw((alias) => `${alias}.transaction_id`)]: transactionId,
    });
    return entity === null ? undefined : WalletLedgerEntryMapper.toDomain(entity);
  }

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
