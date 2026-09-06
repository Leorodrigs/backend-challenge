import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
@Check({
  name: 'outbox_messages_id_not_blank_check',
  expression: 'length(id) > 0 and btrim(id) = id',
})
@Check({
  name: 'outbox_messages_aggregate_id_not_blank_check',
  expression: 'length(aggregate_id) > 0 and btrim(aggregate_id) = aggregate_id',
})
@Check({
  name: 'outbox_messages_event_type_not_blank_check',
  expression: 'length(event_type) > 0 and btrim(event_type) = event_type',
})
@Check({
  name: 'outbox_messages_attempts_check',
  expression: 'attempts >= 0',
})
@Check({
  name: 'outbox_messages_payload_object_check',
  expression: "jsonb_typeof(payload) = 'object'",
})
@Check({
  name: 'outbox_messages_published_at_check',
  expression: 'published_at is null or published_at >= occurred_at',
})
@Check({
  name: 'outbox_messages_schedule_check',
  expression: `(published_at is null and next_attempt_at is not null) or
    (published_at is not null and next_attempt_at is null)`,
})
@Index({
  name: 'outbox_messages_pending_due_index',
  properties: ['nextAttemptAt', 'occurredAt', 'id'],
  where: 'published_at is null',
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'string', columnType: 'text' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'string', columnType: 'text' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({
    fieldName: 'occurred_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts = 0;

  @Property({
    fieldName: 'next_attempt_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  nextAttemptAt!: Date | null;

  @Property({
    fieldName: 'published_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  publishedAt!: Date | null;
}
