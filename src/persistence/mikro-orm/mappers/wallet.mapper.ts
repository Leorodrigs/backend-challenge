import { Money } from '../../../shared/domain/value-objects/money.js';
import { Wallet } from '../../../wallet/domain/wallet.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export class WalletMapper {
  static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balanceAmount,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  static toPersistence(
    wallet: Wallet,
    target = new WalletEntity(),
  ): WalletEntity {
    target.id = wallet.id;
    target.playerId = wallet.playerId;
    target.currency = wallet.currency;
    target.balanceAmount = wallet.balance.toJSON().amount;
    target.version = wallet.version;
    target.createdAt = wallet.createdAt;
    target.updatedAt = wallet.updatedAt;
    return target;
  }
}
