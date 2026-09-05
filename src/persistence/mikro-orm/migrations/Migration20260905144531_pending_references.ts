import { Migration } from '@mikro-orm/migrations';

export class Migration20260905144531_pending_references extends Migration {

  override name = 'Migration20260905144531_pending_references';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "reference_attempt_count" int not null default 0, add "reference_next_attempt_at" timestamptz null, add "reference_deadline_at" timestamptz null;`);
    // Stage 5 never creates pending references. If legacy/imported rows exist,
    // retain their status and snapshot, without inventing previous attempts.
    // Anchor the one-time legacy deadline to creation, never to each retry.
    this.addSql(`update "wager_transactions"
      set reference_deadline_at = created_at + interval '24 hours',
          reference_next_attempt_at = least(current_timestamp, created_at + interval '24 hours')
      where status = 'PENDING_REFERENCE';`);
    this.addSql(`create index "wager_transactions_pending_reference_due_index" on "wager_transactions" ("reference_next_attempt_at", "created_at", "id") where status = 'PENDING_REFERENCE';`);
    this.addSql(`create unique index "wager_transactions_processed_reversal_unique" on "wager_transactions" ("reference_transaction_id", "kind") where reference_transaction_id is not null and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_schedule_check" check ((status = 'PENDING_REFERENCE' and kind in ('REFUND', 'ROLLBACK') and
    reference_next_attempt_at is not null and reference_deadline_at is not null and
    reference_next_attempt_at <= reference_deadline_at) or
    (status <> 'PENDING_REFERENCE' and reference_next_attempt_at is null and reference_deadline_at is null));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_attempt_count_check" check (reference_attempt_count >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_pending_reference_due_index";`);
    this.addSql(`drop index "wager_transactions_processed_reversal_unique";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_schedule_check";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_attempt_count_check";`);
    this.addSql(`alter table "wager_transactions" drop column "reference_attempt_count", drop column "reference_next_attempt_at", drop column "reference_deadline_at";`);
  }

}
