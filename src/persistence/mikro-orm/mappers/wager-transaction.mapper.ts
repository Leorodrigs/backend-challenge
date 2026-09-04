import { Money } from '../../../shared/domain/value-objects/money.js';
import { WagerTransaction } from '../../../wagering/domain/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

export class WagerTransactionMapper {
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: Money.from({
        amount: entity.amount,
        currency: entity.currency,
      }),
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      createdAt: entity.createdAt,
      status: entity.status,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: entity.failureCode ?? undefined,
      processedAt: entity.processedAt ?? undefined,
    });
  }

  static toPersistence(
    transaction: WagerTransaction,
    target = new WagerTransactionEntity(),
  ): WagerTransactionEntity {
    target.id = transaction.id;
    target.providerId = transaction.providerId;
    target.externalTransactionId = transaction.externalTransactionId;
    target.idempotencyKey = transaction.idempotencyKey;
    target.payloadHash = transaction.payloadHash;
    target.walletId = transaction.walletId;
    target.playerId = transaction.playerId;
    target.roundId = transaction.roundId;
    target.gameId = transaction.gameId;
    target.kind = transaction.kind;
    target.amount = transaction.money.toJSON().amount;
    target.currency = transaction.money.currency;
    target.referenceExternalTransactionId =
      transaction.referenceExternalTransactionId ?? null;
    target.createdAt = transaction.createdAt;
    target.status = transaction.status;
    target.referenceTransactionId = transaction.referenceTransactionId ?? null;
    target.failureCode = transaction.failureCode ?? null;
    target.processedAt = transaction.processedAt ?? null;
    return target;
  }
}
