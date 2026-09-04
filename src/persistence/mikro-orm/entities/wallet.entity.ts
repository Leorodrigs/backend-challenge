import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Check({
  name: 'wallets_id_not_blank_check',
  expression: 'length(id) > 0 and btrim(id) = id',
})
@Check({
  name: 'wallets_player_id_not_blank_check',
  expression: 'length(player_id) > 0 and btrim(player_id) = player_id',
})
@Check({
  name: 'wallets_currency_check',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Check({
  name: 'wallets_balance_non_negative_check',
  expression: 'balance_amount >= 0',
})
@Check({
  name: 'wallets_version_positive_check',
  expression: 'version >= 1',
})
@Unique({
  name: 'wallets_player_currency_unique',
  properties: ['playerId', 'currency'],
})
export class WalletEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'string', columnType: 'text' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({
    fieldName: 'balance_amount',
    type: new DecimalType('string'),
    columnType: 'numeric(20,2)',
  })
  balanceAmount!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;

  @Property({
    fieldName: 'updated_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  updatedAt!: Date;
}
