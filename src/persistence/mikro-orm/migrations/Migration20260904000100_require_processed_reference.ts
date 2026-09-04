import { Migration } from '@mikro-orm/migrations';

export class Migration20260904000100_require_processed_reference extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_processed_reference_check" check (
        "kind" not in ('REFUND', 'ROLLBACK') or
        "status" <> 'PROCESSED' or
        "reference_transaction_id" is not null
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
      drop constraint if exists "wager_transactions_processed_reference_check";
    `);
  }
}
