import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Trigger,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { LedgerDirection } from '../../../wallet/domain/ledger-direction.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { WalletEntity } from './wallet.entity.js';

@Entity({ tableName: 'wallet_ledger_entries' })
@Check({
  name: 'wallet_ledger_entries_id_not_blank_check',
  expression: 'length(id) > 0 and btrim(id) = id',
})
@Check({
  name: 'wallet_ledger_entries_direction_check',
  expression: "direction in ('DEBIT', 'CREDIT')",
})
@Check({
  name: 'wallet_ledger_entries_currency_check',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Check({
  name: 'wallet_ledger_entries_amount_non_negative_check',
  expression: 'amount >= 0',
})
@Check({
  name: 'wallet_ledger_entries_balance_before_non_negative_check',
  expression: 'balance_before >= 0',
})
@Check({
  name: 'wallet_ledger_entries_balance_after_non_negative_check',
  expression: 'balance_after >= 0',
})
@Check({
  name: 'wallet_ledger_entries_arithmetic_check',
  expression: `
    (direction = 'CREDIT' and balance_after = balance_before + amount) or
    (direction = 'DEBIT' and balance_after = balance_before - amount)
  `,
})
@Trigger({
  name: 'wallet_ledger_entries_immutable_trigger',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  expression: `
    create trigger "wallet_ledger_entries_immutable_trigger"
    before update or delete on "wallet_ledger_entries"
    for each row execute function "prevent_wallet_ledger_entry_mutation"()
  `,
})
@Unique({
  name: 'wallet_ledger_entries_wallet_transaction_unique',
  properties: ['walletId', 'transactionId'],
})
@Index({
  name: 'wallet_ledger_entries_wallet_created_id_index',
  properties: ['walletId', 'createdAt', 'id'],
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @ManyToOne(() => WalletEntity, {
    mapToPk: true,
    joinColumn: 'wallet_id',
    deleteRule: 'restrict',
    updateRule: 'restrict',
    foreignKeyName: 'wallet_ledger_entries_wallet_fk',
  })
  walletId!: string;

  @ManyToOne(() => WagerTransactionEntity, {
    mapToPk: true,
    joinColumns: ['transaction_id', 'wallet_id'],
    columnTypes: ['text', 'text'],
    referencedColumnNames: ['id', 'wallet_id'],
    ownColumns: ['transaction_id'],
    deleteRule: 'restrict',
    updateRule: 'restrict',
    foreignKeyName: 'wallet_ledger_entries_transaction_wallet_fk',
  })
  transactionId!: string;

  @Property({ type: 'string', columnType: 'text' })
  direction!: LedgerDirection;

  @Property({
    type: new DecimalType('string'),
    columnType: 'numeric(20,2)',
  })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({
    fieldName: 'balance_before',
    type: new DecimalType('string'),
    columnType: 'numeric(20,2)',
  })
  balanceBefore!: string;

  @Property({
    fieldName: 'balance_after',
    type: new DecimalType('string'),
    columnType: 'numeric(20,2)',
  })
  balanceAfter!: string;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;
}
