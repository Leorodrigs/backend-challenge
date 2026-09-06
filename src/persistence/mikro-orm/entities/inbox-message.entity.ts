import {
  Check,
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
@Check({
  name: 'inbox_messages_consumer_name_not_blank_check',
  expression:
    'length(consumer_name) > 0 and btrim(consumer_name) = consumer_name',
})
@Check({
  name: 'inbox_messages_message_id_not_blank_check',
  expression: 'length(message_id) > 0 and btrim(message_id) = message_id',
})
@Check({
  name: 'inbox_messages_payload_hash_check',
  expression: "payload_hash ~ '^[0-9a-f]{64}$'",
})
@Check({
  name: 'inbox_messages_processed_at_check',
  expression: 'processed_at is null or processed_at >= received_at',
})
export class InboxMessageEntity {
  @PrimaryKey({
    fieldName: 'consumer_name',
    type: 'string',
    columnType: 'text',
  })
  consumerName!: string;

  @PrimaryKey({ fieldName: 'message_id', type: 'string', columnType: 'text' })
  messageId!: string;

  @Property({ fieldName: 'payload_hash', type: 'string', columnType: 'text' })
  payloadHash!: string;

  @Property({
    fieldName: 'received_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  receivedAt!: Date;

  @Property({
    fieldName: 'processed_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt!: Date | null;
}
