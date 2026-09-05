import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { WagerTransaction } from '../../../wagering/domain/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper.js';
import type { StoredWagerResult, WagerResultSnapshot } from '../../../wagering/application/wager-result-snapshot.js';

@Injectable()
export class MikroOrmWagerTransactionRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async tryClaim(transaction: WagerTransaction): Promise<boolean> {
    if (!this.entityManager.isInTransaction()) {
      throw new Error('An open transaction is required for a wager claim');
    }
    // Avoid an FK KEY SHARE lock before the financial FOR UPDATE lock.
    // The FK remains mandatory at commit, with both RESTRICT actions intact.
    await this.entityManager.execute('set constraints wager_transactions_wallet_fk deferred');
    const rows = await this.entityManager.execute<{ id: string }[]>(`
      insert into wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        reference_external_transaction_id, created_at, status
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict do nothing returning id
    `, [
      transaction.id, transaction.providerId, transaction.externalTransactionId,
      transaction.idempotencyKey, transaction.payloadHash, transaction.walletId,
      transaction.playerId, transaction.roundId, transaction.gameId, transaction.kind,
      transaction.money.toJSON().amount, transaction.money.currency,
      transaction.referenceExternalTransactionId ?? null, transaction.createdAt,
      transaction.status,
    ]);
    return rows.length === 1;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredWagerResult | undefined> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, { idempotencyKey }, { refresh: true });
    return entity === null ? undefined : {
      transaction: WagerTransactionMapper.toDomain(entity),
      snapshot: WagerTransactionMapper.toResultSnapshot(entity),
    };
  }

  async findByProviderAndExternalTransactionId(
    providerId: string, externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const entity = await this.entityManager.findOne(
      WagerTransactionEntity, { providerId, externalTransactionId }, { refresh: true },
    );
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async saveFinalStateAndResult(transaction: WagerTransaction, snapshot: WagerResultSnapshot): Promise<void> {
    const existing = await this.entityManager.findOneOrFail(WagerTransactionEntity, { id: transaction.id });
    const entity = WagerTransactionMapper.toPersistence(transaction, existing);
    WagerTransactionMapper.applyResultSnapshot(snapshot, entity);
    await this.entityManager.flush();
  }

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
