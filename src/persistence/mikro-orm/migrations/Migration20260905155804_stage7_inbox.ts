import { Migration } from '@mikro-orm/migrations';

export class Migration20260905155804_stage7_inbox extends Migration {
  override name = 'Migration20260905155804_stage7_inbox';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" (
      "consumer_name" text not null,
      "message_id" text not null,
      "payload_hash" text not null,
      "received_at" timestamptz not null,
      "processed_at" timestamptz null,
      constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id")
    );`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_processed_at_check" check (processed_at is null or processed_at >= received_at);`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_payload_hash_check" check (payload_hash ~ '^[0-9a-f]{64}$');`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_message_id_not_blank_check" check (length(message_id) > 0 and btrim(message_id) = message_id);`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_name_not_blank_check" check (length(consumer_name) > 0 and btrim(consumer_name) = consumer_name);`);
  }

  override down(): void | Promise<void> {
    this.addSql('drop table if exists "inbox_messages";');
  }
}
