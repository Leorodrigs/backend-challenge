import { Migration } from '@mikro-orm/migrations';

export class Migration20260906044735_stage8_transactional_outbox extends Migration {

  override name = 'Migration20260906044735_stage8_transactional_outbox';

  override up(): void | Promise<void> {
    this.addSql(`create table "outbox_messages" ("id" text not null, "aggregate_id" text not null, "event_type" text not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_messages_pending_due_index" on "outbox_messages" ("next_attempt_at", "occurred_at", "id") where published_at is null;`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_schedule_check" check ((published_at is null and next_attempt_at is not null) or
    (published_at is not null and next_attempt_at is null));`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_published_at_check" check (published_at is null or published_at >= occurred_at);`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_payload_object_check" check (jsonb_typeof(payload) = 'object');`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_attempts_check" check (attempts >= 0);`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_event_type_not_blank_check" check (length(event_type) > 0 and btrim(event_type) = event_type);`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_aggregate_id_not_blank_check" check (length(aggregate_id) > 0 and btrim(aggregate_id) = aggregate_id);`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_id_not_blank_check" check (length(id) > 0 and btrim(id) = id);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "outbox_messages";`);
  }

}
