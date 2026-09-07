import { createHash } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import type { ApplicationConfiguration } from '../../config/application.config.js';
import type { ApplicationMetrics } from '../../observability/application-metrics.js';
import {
  MessageFailureAction,
  MessageFailureClassifier,
} from './message-failure.classifier.js';
import type { ProcessWagerSqsMessageUseCase } from './process-wager-sqs-message.use-case.js';
import {
  type WagerTransactionRequestedEnvelope,
  WagerTransactionRequestedParser,
} from './wager-transaction-requested.parser.js';

export type SqsDeliveryOutcome =
  | 'ACKED'
  | 'ACK_FAILED'
  | 'RETRY_SCHEDULED'
  | 'RETRY_VISIBILITY_FAILED'
  | 'MOVED_TO_DLQ'
  | 'DLQ_SEND_FAILED'
  | 'DLQ_SOURCE_DELETE_FAILED'
  | 'INVALID_DELIVERY';

export class WagerTransactionSqsConsumer
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WagerTransactionSqsConsumer.name);
  private readonly parser = new WagerTransactionRequestedParser();
  private readonly inFlight = new Map<string, Promise<SqsDeliveryOutcome>>();
  private stopping = false;
  private loopPromise?: Promise<void>;
  private pollAbortController: AbortController | undefined;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly processMessage: ProcessWagerSqsMessageUseCase,
    private readonly failureClassifier: MessageFailureClassifier,
    private readonly configuration: ApplicationConfiguration,
    private readonly metrics?: ApplicationMetrics,
  ) {}

  onModuleInit(): void {
    if (!this.configuration.aws.sqsConsumerEnabled) return;
    this.loopPromise = this.runLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  async pollOnce(): Promise<number> {
    if (this.stopping) return 0;

    const controller = new AbortController();
    this.pollAbortController = controller;
    let messages: Message[];
    try {
      const response = await this.sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: this.configuration.aws.wagerQueueUrl,
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'MessageGroupId',
          ],
          MaxNumberOfMessages:
            this.configuration.aws.sqsMaxMessagesPerPoll,
          WaitTimeSeconds: this.configuration.aws.sqsWaitTimeSeconds,
          VisibilityTimeout: this.configuration.aws.sqsVisibilityTimeout,
        }),
        { abortSignal: controller.signal },
      );
      messages = response.Messages ?? [];
    } finally {
      if (this.pollAbortController === controller) {
        this.pollAbortController = undefined;
      }
    }

    if (this.stopping) {
      await Promise.allSettled(
        messages.map((message) => this.returnVisibility(message)),
      );
      return 0;
    }

    const deliveries = messages.map((message) => this.track(message));
    await Promise.all(deliveries);
    return messages.length;
  }

  async handleMessage(message: Message): Promise<SqsDeliveryOutcome> {
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle === undefined || receiptHandle.length === 0) {
      this.log('invalid_delivery', message, 1);
      return 'INVALID_DELIVERY';
    }

    const receiveCount = this.receiveCount(message);
    let envelope: WagerTransactionRequestedEnvelope | undefined;
    try {
      envelope = this.parser.parse(message.Body);
      const result = await this.processMessage.execute(envelope);
      this.log(
        result.outcome.toLowerCase(),
        message,
        receiveCount,
        envelope,
        undefined,
        result.outcome === 'PROCESSED' &&
        result.financialResult !== undefined
          ? {
              correlationId: result.financialResult.transactionId,
              transactionId: result.financialResult.transactionId,
              status: result.financialResult.status,
              failureCode: result.financialResult.failureCode,
              idempotentReplay: result.financialResult.idempotentReplay,
              financialOutcome: result.financialResult.idempotentReplay
                ? 'replay'
                : result.financialResult.status.toLowerCase(),
            }
          : {},
      );
      return await this.ack(message, envelope, receiveCount);
    } catch (error: unknown) {
      const action = this.failureClassifier.classify(error);
      // A terminal financial conflict is ACK-safe only when the application
      // coordinator has committed the Inbox record in the same transaction.
      // If one escapes that boundary, it follows retry/exhaustion handling.
      if (
        action === MessageFailureAction.Dlq ||
        receiveCount >= this.configuration.aws.sqsMaxReceiveAttempts
      ) {
        return await this.moveToDlq(
          message,
          envelope,
          receiveCount,
          action === MessageFailureAction.Dlq
            ? 'permanent'
            : 'retry_exhausted',
          error,
        );
      }
      return await this.retry(message, envelope, receiveCount, error);
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  visibilityBackoffSeconds(receiveCount: number): number {
    const exponent = Math.max(0, receiveCount - 1);
    return Math.min(
      this.configuration.aws.sqsRetryBaseSeconds *
        2 ** Math.min(exponent, 30),
      this.configuration.aws.sqsRetryMaxSeconds,
    );
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error: unknown) {
        if (this.stopping && this.isAbortError(error)) break;
        this.logger.error({
          consumerName: this.configuration.aws.sqsConsumerName,
          outcome: 'poll_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        await this.waitBeforeNextPoll();
      }
    }
  }

  private track(message: Message): Promise<SqsDeliveryOutcome> {
    const receiptHandle = message.ReceiptHandle;
    const delivery = this.handleMessage(message);
    if (receiptHandle === undefined) return delivery;
    this.inFlight.set(receiptHandle, delivery);
    void delivery.then(
      () => this.inFlight.delete(receiptHandle),
      () => this.inFlight.delete(receiptHandle),
    );
    return delivery;
  }

  private async ack(
    message: Message,
    envelope: WagerTransactionRequestedEnvelope | undefined,
    receiveCount: number,
  ): Promise<SqsDeliveryOutcome> {
    try {
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.configuration.aws.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle!,
        }),
      );
      this.log('acked', message, receiveCount, envelope);
      return 'ACKED';
    } catch (error: unknown) {
      // PostgreSQL is already committed. Redelivery and Inbox deduplication are
      // the recovery mechanism; never compensate the financial transaction.
      this.log('ack_failed', message, receiveCount, envelope, error);
      return 'ACK_FAILED';
    }
  }

  private async retry(
    message: Message,
    envelope: WagerTransactionRequestedEnvelope | undefined,
    receiveCount: number,
    error: unknown,
  ): Promise<SqsDeliveryOutcome> {
    const visibilityTimeout = this.visibilityBackoffSeconds(receiveCount);
    try {
      await this.sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.configuration.aws.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: visibilityTimeout,
        }),
      );
      this.metrics?.recordRetry('sqs');
      this.log(
        'retry_scheduled',
        message,
        receiveCount,
        envelope,
        error,
        { visibilityTimeout },
      );
      return 'RETRY_SCHEDULED';
    } catch (visibilityError: unknown) {
      this.log(
        'retry_visibility_failed',
        message,
        receiveCount,
        envelope,
        visibilityError,
      );
      return 'RETRY_VISIBILITY_FAILED';
    }
  }

  private async moveToDlq(
    message: Message,
    envelope: WagerTransactionRequestedEnvelope | undefined,
    receiveCount: number,
    failureCategory: 'permanent' | 'retry_exhausted',
    error: unknown,
  ): Promise<SqsDeliveryOutcome> {
    try {
      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: this.configuration.aws.wagerDlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: this.messageGroupId(message, envelope),
          MessageDeduplicationId: this.messageDeduplicationId(
            message,
            envelope,
          ),
          MessageAttributes: {
            failureCategory: {
              DataType: 'String',
              StringValue: failureCategory,
            },
            consumerName: {
              DataType: 'String',
              StringValue: this.configuration.aws.sqsConsumerName,
            },
          },
        }),
      );
      this.metrics?.recordDlqMove(
        failureCategory === 'permanent' ? 'permanent' : 'exhausted',
      );
    } catch (sendError: unknown) {
      this.log('dlq_send_failed', message, receiveCount, envelope, sendError);
      return 'DLQ_SEND_FAILED';
    }

    try {
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.configuration.aws.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle!,
        }),
      );
      this.log('moved_to_dlq', message, receiveCount, envelope, error, {
        failureCategory,
      });
      return 'MOVED_TO_DLQ';
    } catch (deleteError: unknown) {
      this.log(
        'dlq_source_delete_failed',
        message,
        receiveCount,
        envelope,
        deleteError,
      );
      return 'DLQ_SOURCE_DELETE_FAILED';
    }
  }

  private async performShutdown(): Promise<void> {
    this.stopping = true;
    this.pollAbortController?.abort();

    const currentWork = [
      ...(this.loopPromise === undefined ? [] : [this.loopPromise]),
      ...this.inFlight.values(),
    ];
    if (currentWork.length === 0) return;

    let graceExpired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        graceExpired = true;
        resolve();
      }, this.configuration.aws.sqsShutdownGraceMs);
    });
    await Promise.race([Promise.allSettled(currentWork), grace]);
    if (timer !== undefined) clearTimeout(timer);

    if (!graceExpired) return;
    const activeReceiptHandles = [...this.inFlight.keys()];
    await Promise.allSettled(
      activeReceiptHandles.map((receiptHandle) =>
        this.sqsClient.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.configuration.aws.wagerQueueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 0,
          }),
        ),
      ),
    );
    this.logger.warn({
      consumerName: this.configuration.aws.sqsConsumerName,
      outcome: 'shutdown_visibility_returned',
      activeDeliveries: activeReceiptHandles.length,
    });
  }

  private async returnVisibility(message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined) return;
    await this.sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.configuration.aws.wagerQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  private receiveCount(message: Message): number {
    const raw = message.Attributes?.ApproximateReceiveCount;
    if (raw === undefined || !/^\d+$/.test(raw)) return 1;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
  }

  private messageGroupId(
    message: Message,
    envelope: WagerTransactionRequestedEnvelope | undefined,
  ): string {
    return this.fifoIdentifier(
      message.Attributes?.MessageGroupId ??
        envelope?.data.walletId ??
        this.configuration.aws.sqsConsumerName,
    );
  }

  private messageDeduplicationId(
    message: Message,
    envelope: WagerTransactionRequestedEnvelope | undefined,
  ): string {
    return this.fifoIdentifier(
      envelope?.messageId ??
        this.logicalMessageId(message.Body) ??
        message.MessageId ??
        this.hash(message.Body ?? ''),
    );
  }

  private logicalMessageId(body: string | undefined): string | undefined {
    if (body === undefined) return undefined;
    try {
      const decoded = JSON.parse(body) as unknown;
      if (
        typeof decoded === 'object' &&
        decoded !== null &&
        !Array.isArray(decoded) &&
        typeof (decoded as Record<string, unknown>).messageId === 'string' &&
        (decoded as Record<string, unknown>).messageId !== ''
      ) {
        return (decoded as Record<string, string>).messageId;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private fifoIdentifier(value: string): string {
    return /^[\w!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~-]{1,128}$/.test(value)
      ? value
      : this.hash(value);
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private waitBeforeNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        resolve,
        this.configuration.aws.sqsRetryBaseSeconds * 1_000,
      );
      timer.unref?.();
    });
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError');
  }

  private log(
    outcome: string,
    message: Message,
    receiveCount: number,
    envelope?: WagerTransactionRequestedEnvelope,
    error?: unknown,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.logger.log({
        consumerName: this.configuration.aws.sqsConsumerName,
        messageId: envelope?.messageId,
        awsMessageId: message.MessageId,
        walletId: envelope?.data.walletId,
        providerId: envelope?.data.providerId,
        receiveCount,
        outcome,
        ...(error instanceof Error ? { errorName: error.name } : {}),
        ...extra,
      });
    } catch {
      // Transport acknowledgement/retry semantics must not depend on logging.
    }
  }
}
