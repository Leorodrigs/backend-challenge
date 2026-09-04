#!/bin/sh
set -eu

WAGER_QUEUE_NAME='wager-transactions.fifo'
WAGER_DLQ_NAME='wager-transactions-dlq.fifo'
AUDIT_QUEUE_NAME='wager-integration-events-audit'
TOPIC_NAME='wager-integration-events'

if WAGER_DLQ_URL="$(
  awslocal sqs get-queue-url \
    --queue-name "$WAGER_DLQ_NAME" \
    --query QueueUrl \
    --output text \
    2>/dev/null
)"; then
  :
else
  WAGER_DLQ_URL="$(
    awslocal sqs create-queue \
      --queue-name "$WAGER_DLQ_NAME" \
      --attributes 'FifoQueue=true,ContentBasedDeduplication=true' \
      --query QueueUrl \
      --output text
  )"
fi

WAGER_DLQ_ARN="$(
  awslocal sqs get-queue-attributes \
    --queue-url "$WAGER_DLQ_URL" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn \
    --output text
)"

if WAGER_QUEUE_URL="$(
  awslocal sqs get-queue-url \
    --queue-name "$WAGER_QUEUE_NAME" \
    --query QueueUrl \
    --output text \
    2>/dev/null
)"; then
  :
else
  WAGER_QUEUE_URL="$(
    awslocal sqs create-queue \
      --queue-name "$WAGER_QUEUE_NAME" \
      --attributes 'FifoQueue=true,ContentBasedDeduplication=true,VisibilityTimeout=30' \
      --query QueueUrl \
      --output text
  )"
fi

REDRIVE_ATTRIBUTES="{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${WAGER_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
awslocal sqs set-queue-attributes \
  --queue-url "$WAGER_QUEUE_URL" \
  --attributes "$REDRIVE_ATTRIBUTES"

if AUDIT_QUEUE_URL="$(
  awslocal sqs get-queue-url \
    --queue-name "$AUDIT_QUEUE_NAME" \
    --query QueueUrl \
    --output text \
    2>/dev/null
)"; then
  :
else
  AUDIT_QUEUE_URL="$(
    awslocal sqs create-queue \
      --queue-name "$AUDIT_QUEUE_NAME" \
      --query QueueUrl \
      --output text
  )"
fi

AUDIT_QUEUE_ARN="$(
  awslocal sqs get-queue-attributes \
    --queue-url "$AUDIT_QUEUE_URL" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn \
    --output text
)"

TOPIC_ARN="$(
  awslocal sns create-topic \
    --name "$TOPIC_NAME" \
    --query TopicArn \
    --output text
)"

AUDIT_QUEUE_ATTRIBUTES="{\"Policy\":\"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Sid\\\":\\\"AllowIntegrationEventsTopic\\\",\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":\\\"sns.amazonaws.com\\\"},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"${AUDIT_QUEUE_ARN}\\\",\\\"Condition\\\":{\\\"ArnEquals\\\":{\\\"aws:SourceArn\\\":\\\"${TOPIC_ARN}\\\"}}}]}\"}"
awslocal sqs set-queue-attributes \
  --queue-url "$AUDIT_QUEUE_URL" \
  --attributes "$AUDIT_QUEUE_ATTRIBUTES"

EXISTING_SUBSCRIPTION="$(
  awslocal sns list-subscriptions-by-topic \
    --topic-arn "$TOPIC_ARN" \
    --query "Subscriptions[?Endpoint=='${AUDIT_QUEUE_ARN}'].SubscriptionArn | [0]" \
    --output text
)"

if [ "$EXISTING_SUBSCRIPTION" = 'None' ]; then
  awslocal sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol sqs \
    --notification-endpoint "$AUDIT_QUEUE_ARN" \
    --attributes RawMessageDelivery=true \
    >/dev/null
fi

printf 'Local messaging infrastructure is ready.\n'
