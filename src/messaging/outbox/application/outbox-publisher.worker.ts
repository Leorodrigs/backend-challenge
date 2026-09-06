import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import type { WagerProcessingPersistence } from '../../../wagering/application/wager-processing.persistence.js';
import type { IntegrationEventPublisher } from './integration-event.publisher.js';

export type OutboxPublisherOutcome = 'PUBLISHED' | 'RETRY_SCHEDULED';

export interface OutboxPublisherOptions {
  enabled: boolean;
  batchSize: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly persistence: WagerProcessingPersistence,
    private readonly publisher: IntegrationEventPublisher,
    private readonly options: Readonly<OutboxPublisherOptions>,
  ) {
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 ||
        !Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1 ||
        !Number.isSafeInteger(options.retryBaseMs) || options.retryBaseMs < 1 ||
        !Number.isSafeInteger(options.retryMaxMs) || options.retryMaxMs < 1 ||
        options.retryBaseMs > options.retryMaxMs) {
      throw new RangeError('Invalid Outbox publisher options');
    }
  }

  onModuleInit(): void {
    if (!this.options.enabled || this.loopPromise !== undefined) return;
    this.stopping = false;
    this.loopPromise = this.poll();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  async runOnce(now = new Date()): Promise<OutboxPublisherOutcome[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const outcomes: OutboxPublisherOutcome[] = [];
      for (let index = 0; index < this.options.batchSize; index++) {
        const outcome = await this.persistence.transactional(async (context) => {
          const message = await context.outbox.claimNextDue(now);
          if (message === undefined) return undefined;

          try {
            await this.publisher.publish(message);
          } catch (error: unknown) {
            message.scheduleRetry(now, {
              baseDelayMs: this.options.retryBaseMs,
              maxDelayMs: this.options.retryMaxMs,
            });
            await context.outbox.save(message);
            this.logger.warn({
              eventId: message.id,
              eventType: message.eventType,
              aggregateId: message.aggregateId,
              correlationId: message.payload.correlationId,
              attempts: message.attempts,
              outcome: 'RETRY_SCHEDULED',
              errorName: error instanceof Error ? error.name : 'UnknownError',
            });
            return 'RETRY_SCHEDULED' as const;
          }

          message.markPublished(new Date());
          await context.outbox.save(message);
          this.logger.log({
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            correlationId: message.payload.correlationId,
            attempts: message.attempts,
            outcome: 'PUBLISHED',
          });
          return 'PUBLISHED' as const;
        });
        if (outcome === undefined) break;
        outcomes.push(outcome);
      }
      return outcomes;
    } finally {
      this.running = false;
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        this.logger.error({
          outcome: 'ITERATION_FAILED',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
      if (!this.stopping) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => resolve();
      this.timer = setTimeout(resolve, this.options.pollIntervalMs);
    }).finally(() => {
      this.timer = undefined;
      this.wake = undefined;
    });
  }
}
