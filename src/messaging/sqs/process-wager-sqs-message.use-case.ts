import { InboxMessage } from '../inbox/domain/inbox-message.js';
import { InboxPayloadConflictError } from '../inbox/errors/inbox-message.errors.js';
import type {
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../../wagering/application/process-wager-transaction.use-case.js';
import type { WagerProcessingPersistence } from '../../wagering/application/wager-processing.persistence.js';
import type {
  ApplicationMetrics,
  ProcessingOutcome,
} from '../../observability/application-metrics.js';
import { InboxEnvelopeHasher } from './inbox-envelope.hasher.js';
import {
  MessageFailureAction,
  MessageFailureClassifier,
} from './message-failure.classifier.js';
import type { WagerTransactionRequestedEnvelope } from './wager-transaction-requested.parser.js';

export type ProcessWagerSqsMessageResult =
  | {
      outcome: 'PROCESSED';
      financialResult: ProcessWagerTransactionResult;
    }
  | { outcome: 'DUPLICATE' }
  | { outcome: 'TERMINAL_ACK'; errorName: string };

export class ProcessWagerSqsMessageUseCase {
  constructor(
    private readonly persistence: WagerProcessingPersistence,
    private readonly wagerUseCase: ProcessWagerTransactionUseCase,
    private readonly consumerName: string,
    private readonly hasher = new InboxEnvelopeHasher(),
    private readonly failureClassifier = new MessageFailureClassifier(),
    private readonly metrics?: ApplicationMetrics,
  ) {}

  async execute(
    envelope: WagerTransactionRequestedEnvelope,
  ): Promise<ProcessWagerSqsMessageResult> {
    const startedAt = performance.now();
    const received = InboxMessage.receive({
      consumerName: this.consumerName,
      messageId: envelope.messageId,
      payloadHash: this.hasher.hash(envelope),
      receivedAt: new Date(),
    });

    try {
      const result = await this.persistence.transactional(async (context) => {
        const inbox = context.inbox;
        if (inbox === undefined) {
          throw new Error('Inbox persistence is unavailable in this transaction');
        }

        const inserted = await inbox.tryReceive(received);
        const claimed = inserted
          ? received
          : await inbox.findForUpdate(
              received.consumerName,
              received.messageId,
            );
        if (claimed === undefined) {
          throw new Error('Inbox claim disappeared before it could be locked');
        }
        if (claimed.payloadHash !== received.payloadHash) {
          throw new InboxPayloadConflictError(
            received.consumerName,
            received.messageId,
          );
        }
        if (claimed.isProcessed()) {
          return { outcome: 'DUPLICATE' } as const;
        }

        let financialResult: ProcessWagerTransactionResult;
        try {
          const { idempotencyKey, ...payload } = envelope.data;
          financialResult = await this.wagerUseCase.executeInContext(context, {
            idempotencyKey,
            payload,
          });
        } catch (error: unknown) {
          if (
            this.failureClassifier.classify(error) !==
            MessageFailureAction.TerminalAck
          ) {
            throw error;
          }
          claimed.markProcessed(new Date());
          await inbox.save(claimed);
          return {
            outcome: 'TERMINAL_ACK',
            errorName: error instanceof Error ? error.name : 'UnknownError',
          } as const;
        }

        claimed.markProcessed(new Date());
        await inbox.save(claimed);
        return { outcome: 'PROCESSED', financialResult } as const;
      });

      const outcome = this.metricOutcome(result);
      if (result.outcome === 'DUPLICATE') {
        this.metrics?.recordDuplicate('inbox');
      } else if (
        result.outcome === 'PROCESSED' &&
        result.financialResult.idempotentReplay
      ) {
        this.metrics?.recordDuplicate('business');
      }
      this.metrics?.recordProcessingDuration(
        'sqs',
        outcome,
        (performance.now() - startedAt) / 1_000,
      );
      return result;
    } catch (error: unknown) {
      this.metrics?.recordProcessingDuration(
        'sqs',
        'error',
        (performance.now() - startedAt) / 1_000,
      );
      throw error;
    }
  }

  private metricOutcome(result: ProcessWagerSqsMessageResult): ProcessingOutcome {
    if (result.outcome === 'DUPLICATE') return 'duplicate';
    if (result.outcome === 'TERMINAL_ACK') return 'rejected';
    if (result.financialResult.idempotentReplay) return 'replay';
    if (result.financialResult.status === 'PROCESSED') return 'processed';
    if (result.financialResult.status === 'REJECTED') return 'rejected';
    if (result.financialResult.status === 'PENDING_REFERENCE') {
      return 'pending_reference';
    }
    return 'error';
  }
}
