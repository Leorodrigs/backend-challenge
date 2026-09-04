import { Money } from '../../../shared/domain/value-objects/money.js';
import { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';

export class WalletLedgerEntryMapper {
  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction,
      money: Money.from({
        amount: entity.amount,
        currency: entity.currency,
      }),
      balanceBefore: Money.from({
        amount: entity.balanceBefore,
        currency: entity.currency,
      }),
      balanceAfter: Money.from({
        amount: entity.balanceAfter,
        currency: entity.currency,
      }),
      createdAt: entity.createdAt,
    });
  }

  static toPersistence(
    entry: WalletLedgerEntry,
  ): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.toJSON().amount;
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.toJSON().amount;
    entity.balanceAfter = entry.balanceAfter.toJSON().amount;
    entity.createdAt = entry.createdAt;
    return entity;
  }
}
