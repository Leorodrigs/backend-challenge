import { Migration } from '@mikro-orm/migrations';

export class Migration20260903000100_stage3_financial_persistence extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" text not null,
        "player_id" text not null,
        "currency" varchar(3) not null,
        "balance_amount" numeric(20,2) not null,
        "version" integer not null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_id_not_blank_check" check (length("id") > 0 and btrim("id") = "id"),
        constraint "wallets_player_id_not_blank_check" check (length("player_id") > 0 and btrim("player_id") = "player_id"),
        constraint "wallets_currency_check" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_balance_non_negative_check" check ("balance_amount" >= 0),
        constraint "wallets_version_positive_check" check ("version" >= 1)
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" text not null,
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null,
        "payload_hash" text not null,
        "wallet_id" text not null,
        "player_id" text not null,
        "round_id" text not null,
        "game_id" text not null,
        "kind" text not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "reference_external_transaction_id" text null,
        "created_at" timestamptz not null,
        "status" text not null,
        "reference_transaction_id" text null,
        "failure_code" text null,
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key"),
        constraint "wager_transactions_id_wallet_unique" unique ("id", "wallet_id"),
        constraint "wager_transactions_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update restrict on delete restrict,
        constraint "wager_transactions_reference_fk" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on update restrict on delete restrict,
        constraint "wager_transactions_required_fields_check" check (
          length("id") > 0 and btrim("id") = "id" and
          length("provider_id") > 0 and btrim("provider_id") = "provider_id" and
          length("external_transaction_id") > 0 and btrim("external_transaction_id") = "external_transaction_id" and
          length("idempotency_key") > 0 and btrim("idempotency_key") = "idempotency_key" and
          length("payload_hash") > 0 and btrim("payload_hash") = "payload_hash" and
          length("player_id") > 0 and btrim("player_id") = "player_id" and
          length("round_id") > 0 and btrim("round_id") = "round_id" and
          length("game_id") > 0 and btrim("game_id") = "game_id"
        ),
        constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_non_negative_check" check ("amount" >= 0),
        constraint "wager_transactions_currency_check" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_reference_required_check" check (
          "kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null
        ),
        constraint "wager_transactions_reference_not_blank_check" check (
          "reference_external_transaction_id" is null or
          (length("reference_external_transaction_id") > 0 and btrim("reference_external_transaction_id") = "reference_external_transaction_id")
        ),
        constraint "wager_transactions_failure_code_check" check (
          "failure_code" is null or "failure_code" in (
            'INSUFFICIENT_FUNDS',
            'CURRENCY_MISMATCH',
            'REFERENCE_NOT_FOUND',
            'INVALID_REFERENCE',
            'REFERENCE_ALREADY_REVERSED',
            'REVERSAL_AMOUNT_MISMATCH',
            'REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE',
            'PERMANENT_INFRASTRUCTURE_FAILURE'
          )
        ),
        constraint "wager_transactions_terminal_failure_check" check (
          ("status" in ('REJECTED', 'FAILED')) = ("failure_code" is not null)
        ),
        constraint "wager_transactions_processed_at_check" check (
          ("status" = 'PROCESSED') = ("processed_at" is not null)
        )
      );
    `);

    this.addSql(
      'create index "wager_transactions_wallet_id_index" on "wager_transactions" ("wallet_id");',
    );
    this.addSql(
      'create index "wager_transactions_status_index" on "wager_transactions" ("status");',
    );

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" text not null,
        "wallet_id" text not null,
        "transaction_id" text not null,
        "direction" text not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_entries_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update restrict on delete restrict,
        constraint "wallet_ledger_entries_transaction_wallet_fk" foreign key ("transaction_id", "wallet_id") references "wager_transactions" ("id", "wallet_id") on update restrict on delete restrict,
        constraint "wallet_ledger_entries_id_not_blank_check" check (length("id") > 0 and btrim("id") = "id"),
        constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_currency_check" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_entries_amount_non_negative_check" check ("amount" >= 0),
        constraint "wallet_ledger_entries_balance_before_non_negative_check" check ("balance_before" >= 0),
        constraint "wallet_ledger_entries_balance_after_non_negative_check" check ("balance_after" >= 0),
        constraint "wallet_ledger_entries_arithmetic_check" check (
          ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount") or
          ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
        )
      );
    `);

    this.addSql(
      'create index "wallet_ledger_entries_wallet_created_id_index" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");',
    );

    this.addSql(`
      create function "prevent_wallet_ledger_entry_mutation"()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'wallet_ledger_entries is immutable' using errcode = '55000';
      end;
      $$;
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_immutable_trigger"
      before update or delete on "wallet_ledger_entries"
      for each row execute function "prevent_wallet_ledger_entry_mutation"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop trigger if exists "wallet_ledger_entries_immutable_trigger" on "wallet_ledger_entries";',
    );
    this.addSql(
      'drop function if exists "prevent_wallet_ledger_entry_mutation"();',
    );
    this.addSql('drop table if exists "wallet_ledger_entries";');
    this.addSql('drop table if exists "wager_transactions";');
    this.addSql('drop table if exists "wallets";');
  }
}
