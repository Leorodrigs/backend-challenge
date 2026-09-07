import { describe, expect, mock, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type { ApplicationConfiguration } from '../../../../src/config/application.config.js';
import { MessageFailureClassifier } from '../../../../src/messaging/sqs/message-failure.classifier.js';
import type { ProcessWagerSqsMessageUseCase } from '../../../../src/messaging/sqs/process-wager-sqs-message.use-case.js';
import { WagerTransactionSqsConsumer } from '../../../../src/messaging/sqs/wager-transaction-sqs.consumer.js';
import { ApplicationMetrics } from '../../../../src/observability/application-metrics.js';

const body = JSON.stringify({
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-09-05T12:00:00.000Z',
  data: {
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    playerId: 'player',
    walletId: 'wallet',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

function configuration(
  overrides: Partial<ApplicationConfiguration['aws']> = {},
): ApplicationConfiguration {
  return {
    app: { environment: 'test', port: 3000 },
    database: {
      host: 'localhost',
      port: 5432,
      name: 'test',
      user: 'test',
      password: 'test',
    },
    aws: {
      region: 'us-east-1',
      wagerQueueUrl: 'http://sqs/source.fifo',
      wagerDlqUrl: 'http://sqs/dlq.fifo',
      sqsWaitTimeSeconds: 0,
      sqsVisibilityTimeout: 30,
      sqsConsumerEnabled: false,
      sqsConsumerName: 'wager-transactions-v1',
      sqsMaxMessagesPerPoll: 10,
      sqsRetryBaseSeconds: 3,
      sqsRetryMaxSeconds: 10,
      sqsMaxReceiveAttempts: 3,
      sqsShutdownGraceMs: 20,
      integrationEventsTopicArn: 'arn:test',
      ...overrides,
    },
    workers: {
      referenceRetryBaseMs: 1,
      referenceRetryMaxMs: 1,
      referenceTtlMs: 1,
      outboxBatchSize: 1,
      outboxPollIntervalMs: 1,
      outboxPublisherEnabled: false,
      outboxRetryBaseMs: 1,
      outboxRetryMaxMs: 1,
    },
  };
}

function delivery(overrides: Partial<Message> = {}): Message {
  return {
    MessageId: 'aws-msg-1',
    ReceiptHandle: 'receipt-1',
    Body: body,
    Attributes: {
      ApproximateReceiveCount: '1',
      MessageGroupId: 'wallet',
    },
    ...overrides,
  };
}

function consumerWith(
  sendImplementation: (command: unknown) => Promise<unknown>,
  executeImplementation: () => Promise<unknown>,
  overrides: Partial<ApplicationConfiguration['aws']> = {},
  metrics?: ApplicationMetrics,
) {
  const send = mock(sendImplementation);
  const execute = mock(executeImplementation);
  const consumer = new WagerTransactionSqsConsumer(
    { send } as unknown as SQSClient,
    { execute } as unknown as ProcessWagerSqsMessageUseCase,
    new MessageFailureClassifier(),
    configuration(overrides),
    metrics,
  );
  return { consumer, send, execute };
}

describe('WagerTransactionSqsConsumer', () => {
  test('ACK happens only after the PostgreSQL application service resolves', async () => {
    const order: string[] = [];
    const state = consumerWith(
      async (command) => {
        if (command instanceof DeleteMessageCommand) order.push('delete');
        return {};
      },
      async () => {
        order.push('commit');
        return { outcome: 'PROCESSED' };
      },
    );

    expect(await state.consumer.handleMessage(delivery())).toBe('ACKED');
    expect(order).toEqual(['commit', 'delete']);
  });

  test('transient failure changes visibility with exponential capped backoff and never ACKs', async () => {
    const metrics = new ApplicationMetrics();
    const state = consumerWith(
      async () => ({}),
      async () => {
        throw new Error('database unavailable');
      },
      {},
      metrics,
    );
    const outcome = await state.consumer.handleMessage(
      delivery({ Attributes: { ApproximateReceiveCount: '2' } }),
    );

    expect(outcome).toBe('RETRY_SCHEDULED');
    const commands = state.send.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect((commands[0] as ChangeMessageVisibilityCommand).input.VisibilityTimeout).toBe(6);
    expect(commands.some((command) => command instanceof DeleteMessageCommand)).toBe(false);
    expect(state.consumer.visibilityBackoffSeconds(10)).toBe(10);
    expect(await metrics.metrics()).toContain(
      'wager_retries_total{component="sqs"} 1',
    );
  });

  test('permanent malformed body sends to FIFO DLQ before deleting source', async () => {
    const order: string[] = [];
    const state = consumerWith(
      async (command) => {
        if (command instanceof SendMessageCommand) order.push('send-dlq');
        if (command instanceof DeleteMessageCommand) order.push('delete-source');
        return {};
      },
      async () => ({ outcome: 'PROCESSED' }),
    );

    expect(
      await state.consumer.handleMessage(delivery({ Body: '{invalid' })),
    ).toBe('MOVED_TO_DLQ');
    expect(order).toEqual(['send-dlq', 'delete-source']);
    const send = state.send.mock.calls[0]?.[0] as SendMessageCommand;
    expect(send.input.MessageBody).toBe('{invalid');
    expect(send.input.MessageGroupId).toBe('wallet');
    expect(send.input.MessageDeduplicationId).toBe('aws-msg-1');
  });

  test('DLQ send failure preserves the source message', async () => {
    const metrics = new ApplicationMetrics();
    const state = consumerWith(
      async (command) => {
        if (command instanceof SendMessageCommand) throw new Error('DLQ down');
        return {};
      },
      async () => ({ outcome: 'PROCESSED' }),
      {},
      metrics,
    );

    expect(
      await state.consumer.handleMessage(delivery({ Body: 'invalid' })),
    ).toBe('DLQ_SEND_FAILED');
    expect(
      state.send.mock.calls.some(
        ([command]) => command instanceof DeleteMessageCommand,
      ),
    ).toBe(false);
    expect(await metrics.metrics()).not.toContain(
      'wager_dlq_moves_total{reason="permanent"}',
    );
  });

  test('retry exhaustion moves to DLQ instead of changing visibility', async () => {
    const metrics = new ApplicationMetrics();
    const state = consumerWith(
      async () => ({}),
      async () => {
        throw new Error('still unavailable');
      },
      {},
      metrics,
    );

    expect(
      await state.consumer.handleMessage(
        delivery({ Attributes: { ApproximateReceiveCount: '3' } }),
      ),
    ).toBe('MOVED_TO_DLQ');
    const commands = state.send.mock.calls.map(([command]) => command);
    expect(commands[0]).toBeInstanceOf(SendMessageCommand);
    expect(commands[1]).toBeInstanceOf(DeleteMessageCommand);
    expect(
      commands.some(
        (command) => command instanceof ChangeMessageVisibilityCommand,
      ),
    ).toBe(false);
    expect(await metrics.metrics()).toContain(
      'wager_dlq_moves_total{reason="exhausted"} 1',
    );
  });

  test('ACK failure leaves the committed message for Inbox-safe redelivery', async () => {
    const state = consumerWith(
      async (command) => {
        if (command instanceof DeleteMessageCommand) throw new Error('SQS down');
        return {};
      },
      async () => ({ outcome: 'PROCESSED' }),
    );

    expect(await state.consumer.handleMessage(delivery())).toBe('ACK_FAILED');
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  test('shutdown prevents later receives', async () => {
    const state = consumerWith(
      async (command) => {
        if (command instanceof ReceiveMessageCommand) return { Messages: [] };
        return {};
      },
      async () => ({ outcome: 'PROCESSED' }),
    );

    await state.consumer.shutdown();
    expect(await state.consumer.pollOnce()).toBe(0);
    expect(state.send).not.toHaveBeenCalled();
  });

  test('shutdown waits for in-flight commit and ACK inside the grace period', async () => {
    let delivered = false;
    let resolveProcessing!: (value: { outcome: 'PROCESSED' }) => void;
    const processing = new Promise<{ outcome: 'PROCESSED' }>((resolve) => {
      resolveProcessing = resolve;
    });
    const state = consumerWith(
      async (command) => {
        if (command instanceof ReceiveMessageCommand && !delivered) {
          delivered = true;
          return { Messages: [delivery()] };
        }
        return {};
      },
      async () => processing,
      { sqsShutdownGraceMs: 100 },
    );
    const poll = state.consumer.pollOnce();
    while (state.execute.mock.calls.length === 0) await Bun.sleep(0);

    const shutdown = state.consumer.shutdown();
    resolveProcessing({ outcome: 'PROCESSED' });
    await shutdown;
    await poll;

    expect(
      state.send.mock.calls.some(
        ([command]) => command instanceof DeleteMessageCommand,
      ),
    ).toBe(true);
    expect(
      state.send.mock.calls.some(
        ([command]) =>
          command instanceof ChangeMessageVisibilityCommand &&
          command.input.VisibilityTimeout === 0,
      ),
    ).toBe(false);
  });

  test('shutdown returns visibility zero when in-flight work exceeds grace', async () => {
    let delivered = false;
    let resolveProcessing!: (value: { outcome: 'PROCESSED' }) => void;
    const processing = new Promise<{ outcome: 'PROCESSED' }>((resolve) => {
      resolveProcessing = resolve;
    });
    const state = consumerWith(
      async (command) => {
        if (command instanceof ReceiveMessageCommand && !delivered) {
          delivered = true;
          return { Messages: [delivery()] };
        }
        return {};
      },
      async () => processing,
      { sqsShutdownGraceMs: 1 },
    );
    const poll = state.consumer.pollOnce();
    while (state.execute.mock.calls.length === 0) await Bun.sleep(0);

    await state.consumer.shutdown();
    expect(
      state.send.mock.calls.some(
        ([command]) =>
          command instanceof ChangeMessageVisibilityCommand &&
          command.input.VisibilityTimeout === 0 &&
          command.input.ReceiptHandle === 'receipt-1',
      ),
    ).toBe(true);

    resolveProcessing({ outcome: 'PROCESSED' });
    await poll;
  });
});
