import { DeferMode } from '@mikro-orm/core';
import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { FailureCode } from '../../../wagering/domain/failure-code.js';
import { WagerTransactionKind } from '../../../wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../wagering/domain/wager-transaction-status.js';
import { WalletEntity } from './wallet.entity.js';
import { ExactDecimalType } from '../types/exact-decimal.type.js';

@Entity({ tableName: 'wager_transactions' })
@Check({ name: 'wager_transactions_finite_money_check', expression: "amount <> 'NaN'::numeric" })
@Check({
  name: 'wager_transactions_reference_attempt_count_check',
  expression: 'reference_attempt_count >= 0',
})
@Check({
  name: 'wager_transactions_reference_schedule_check',
  expression: `(status = 'PENDING_REFERENCE' and kind in ('REFUND', 'ROLLBACK') and
    reference_next_attempt_at is not null and reference_deadline_at is not null and
    reference_next_attempt_at <= reference_deadline_at) or
    (status <> 'PENDING_REFERENCE' and reference_next_attempt_at is null and reference_deadline_at is null)`,
})
@Unique({
  name: 'wager_transactions_processed_reversal_unique',
  properties: ['referenceTransactionId', 'kind'],
  where: "reference_transaction_id is not null and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')",
})
@Index({
  name: 'wager_transactions_pending_reference_due_index',
  properties: ['referenceNextAttemptAt', 'createdAt', 'id'],
  where: "status = 'PENDING_REFERENCE'",
})
@Check({
  name: 'wager_transactions_result_all_or_none_check',
  expression: `(result_balance_amount is null and result_balance_currency is null and result_wallet_version is null) or
    (result_balance_amount is not null and result_balance_currency is not null and result_wallet_version is not null)`,
})
@Check({
  name: 'wager_transactions_result_balance_check',
  expression: "result_balance_amount >= 0 and result_balance_amount <> 'NaN'::numeric",
})
@Check({
  name: 'wager_transactions_result_currency_check',
  expression: "result_balance_currency ~ '^[A-Z]{3}$'",
})
@Check({
  name: 'wager_transactions_result_version_check',
  expression: 'result_wallet_version >= 1',
})
@Check({
  name: 'wager_transactions_required_fields_check',
  expression: `
    length(id) > 0 and btrim(id) = id and
    length(provider_id) > 0 and btrim(provider_id) = provider_id and
    length(external_transaction_id) > 0 and btrim(external_transaction_id) = external_transaction_id and
    length(idempotency_key) > 0 and btrim(idempotency_key) = idempotency_key and
    length(payload_hash) > 0 and btrim(payload_hash) = payload_hash and
    length(player_id) > 0 and btrim(player_id) = player_id and
    length(round_id) > 0 and btrim(round_id) = round_id and
    length(game_id) > 0 and btrim(game_id) = game_id
  `,
})
@Check({
  name: 'wager_transactions_kind_check',
  expression:
    "kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
})
@Check({
  name: 'wager_transactions_status_check',
  expression:
    "status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
})
@Check({
  name: 'wager_transactions_amount_non_negative_check',
  expression: 'amount >= 0',
})
@Check({
  name: 'wager_transactions_currency_check',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Check({
  name: 'wager_transactions_reference_required_check',
  expression:
    "(kind <> ALL (ARRAY['REFUND'::text, 'ROLLBACK'::text])) OR (reference_external_transaction_id IS NOT NULL)",
})
@Check({
  name: 'wager_transactions_reference_not_blank_check',
  expression: `
    reference_external_transaction_id is null or
    (length(reference_external_transaction_id) > 0 and btrim(reference_external_transaction_id) = reference_external_transaction_id)
  `,
})
@Check({
  name: 'wager_transactions_failure_code_check',
  expression:
    "(failure_code IS NULL) OR (failure_code = ANY (ARRAY['INSUFFICIENT_FUNDS'::text, 'CURRENCY_MISMATCH'::text, 'REFERENCE_NOT_FOUND'::text, 'INVALID_REFERENCE'::text, 'REFERENCE_ALREADY_REVERSED'::text, 'REVERSAL_AMOUNT_MISMATCH'::text, 'REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE'::text, 'PERMANENT_INFRASTRUCTURE_FAILURE'::text]))",
})
@Check({
  name: 'wager_transactions_terminal_failure_check',
  expression:
    "(status in ('REJECTED', 'FAILED')) = (failure_code is not null)",
})
@Check({
  name: 'wager_transactions_processed_at_check',
  expression: "(status = 'PROCESSED') = (processed_at is not null)",
})
@Check({
  name: 'wager_transactions_processed_reference_check',
  expression:
    "(kind <> ALL (ARRAY['REFUND'::text, 'ROLLBACK'::text])) OR (status <> 'PROCESSED'::text) OR (reference_transaction_id IS NOT NULL)",
})
@Unique({
  name: 'wager_transactions_provider_external_unique',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'wager_transactions_idempotency_key_unique',
  properties: ['idempotencyKey'],
})
@Unique({
  name: 'wager_transactions_id_wallet_unique',
  properties: ['id', 'walletId'],
})
@Index({ name: 'wager_transactions_wallet_id_index', properties: ['walletId'] })
@Index({ name: 'wager_transactions_status_index', properties: ['status'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'string', columnType: 'text' })
  providerId!: string;

  @Property({
    fieldName: 'external_transaction_id',
    type: 'string',
    columnType: 'text',
  })
  externalTransactionId!: string;

  @Property({
    fieldName: 'idempotency_key',
    type: 'string',
    columnType: 'text',
  })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'string', columnType: 'text' })
  payloadHash!: string;

  @ManyToOne(() => WalletEntity, {
    mapToPk: true,
    joinColumn: 'wallet_id',
    deleteRule: 'restrict',
    updateRule: 'restrict',
    foreignKeyName: 'wager_transactions_wallet_fk',
    deferMode: DeferMode.INITIALLY_IMMEDIATE,
  })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'string', columnType: 'text' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'string', columnType: 'text' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'string', columnType: 'text' })
  gameId!: string;

  @Property({ type: 'string', columnType: 'text' })
  kind!: WagerTransactionKind;

  @Property({
    type: new ExactDecimalType(),
    columnType: 'numeric(20,2)',
  })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'string',
    columnType: 'text',
    nullable: true,
  })
  referenceExternalTransactionId!: string | null;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;

  @Property({ type: 'string', columnType: 'text' })
  status!: WagerTransactionStatus;

  @ManyToOne(() => WagerTransactionEntity, {
    mapToPk: true,
    joinColumn: 'reference_transaction_id',
    nullable: true,
    deleteRule: 'restrict',
    updateRule: 'restrict',
    foreignKeyName: 'wager_transactions_reference_fk',
  })
  referenceTransactionId!: string | null;

  @Property({ type: 'string', columnType: 'text', nullable: true })
  failureCode!: FailureCode | null;

  @Property({
    fieldName: 'processed_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt!: Date | null;

  @Property({ fieldName: 'result_balance_amount', type: new ExactDecimalType(), columnType: 'numeric(20,2)', nullable: true })
  resultBalanceAmount: string | null = null;

  @Property({ fieldName: 'result_balance_currency', type: 'string', columnType: 'varchar(3)', nullable: true })
  resultBalanceCurrency: string | null = null;

  @Property({ fieldName: 'result_wallet_version', type: 'integer', nullable: true })
  resultWalletVersion: number | null = null;

  @Property({ fieldName: 'reference_attempt_count', type: 'integer', default: 0 })
  referenceAttemptCount = 0;

  @Property({ fieldName: 'reference_next_attempt_at', type: 'datetime', columnType: 'timestamptz', nullable: true })
  referenceNextAttemptAt: Date | null = null;

  @Property({ fieldName: 'reference_deadline_at', type: 'datetime', columnType: 'timestamptz', nullable: true })
  referenceDeadlineAt: Date | null = null;
}
