import { describe, expect, mock, test } from 'bun:test';

import { InboxMessage } from '../../../../src/messaging/inbox/domain/inbox-message.js';
import { InboxEnvelopeHasher } from '../../../../src/messaging/sqs/inbox-envelope.hasher.js';
import { ProcessWagerSqsMessageUseCase } from '../../../../src/messaging/sqs/process-wager-sqs-message.use-case.js';
import { WagerTransactionRequestedParser } from '../../../../src/messaging/sqs/wager-transaction-requested.parser.js';
import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../../../src/wagering/application/errors/wager-processing.errors.js';
import type { ProcessWagerTransactionUseCase } from '../../../../src/wagering/application/process-wager-transaction.use-case.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../../../src/wagering/application/wager-processing.persistence.js';
import { WagerTransactionStatus } from '../../../../src/wagering/domain/wager-transaction-status.js';

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

function setup(existing?: InboxMessage) {
  const events: string[] = [];
  const saved: InboxMessage[] = [];
  const context = {
    inbox: {
      tryReceive: mock(async () => existing === undefined),
      findForUpdate: mock(async () => existing),
      save: mock(async (message: InboxMessage) => {
        events.push('inbox-processed');
        saved.push(message);
      }),
    },
    wallets: {},
    transactions: {},
    ledger: {},
  } as unknown as WagerProcessingContext;
  const persistence: WagerProcessingPersistence = {
    transactional: async <T>(
      work: (transactionContext: WagerProcessingContext) => Promise<T>,
    ): Promise<T> => {
      events.push('begin');
      const result = await work(context);
      events.push('commit');
      return result;
    },
  };
  const executeInContext = mock(async () => {
    events.push('finance');
    return {
      transactionId: 'transaction',
      status: WagerTransactionStatus.Processed,
      balance: Money.from({ amount: '75.00', currency: 'BRL' }),
      walletVersion: 2,
      idempotentReplay: false,
    };
  });
  const financial = { executeInContext } as unknown as ProcessWagerTransactionUseCase;
  const useCase = new ProcessWagerSqsMessageUseCase(
    persistence,
    financial,
    'wager-transactions-v1',
  );
  return { events, saved, context, executeInContext, useCase };
}

describe('ProcessWagerSqsMessageUseCase', () => {
  const envelope = new WagerTransactionRequestedParser().parse(body);

  test('commits Inbox processed with the financial result in one transaction', async () => {
    const { events, saved, executeInContext, useCase } = setup();

    const result = await useCase.execute(envelope);

    expect(result.outcome).toBe('PROCESSED');
    expect(executeInContext).toHaveBeenCalledTimes(1);
    expect(saved[0]?.isProcessed()).toBe(true);
    expect(events).toEqual(['begin', 'finance', 'inbox-processed', 'commit']);
  });

  test('processed Inbox duplicate skips all financial work', async () => {
    const existing = InboxMessage.receive({
      consumerName: 'wager-transactions-v1',
      messageId: envelope.messageId,
      payloadHash: new InboxEnvelopeHasher().hash(envelope),
      receivedAt: new Date('2026-09-05T12:00:00.000Z'),
    });
    existing.markProcessed(new Date('2026-09-05T12:00:01.000Z'));
    const { events, executeInContext, useCase } = setup(existing);

    expect(await useCase.execute(envelope)).toEqual({ outcome: 'DUPLICATE' });
    expect(executeInContext).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'commit']);
  });

  test('business conflict marks Inbox processed and commits for ACK', async () => {
    const state = setup();
    state.executeInContext.mockImplementation(async () => {
      state.events.push('business-conflict');
      throw new IdempotencyConflictError('key');
    });

    const result = await state.useCase.execute(envelope);

    expect(result).toEqual({
      outcome: 'TERMINAL_ACK',
      errorName: 'IdempotencyConflictError',
    });
    expect(state.saved[0]?.isProcessed()).toBe(true);
    expect(state.events).toEqual([
      'begin',
      'business-conflict',
      'inbox-processed',
      'commit',
    ]);
  });

  test('permanent processing failure escapes so the transaction rolls back', async () => {
    const state = setup();
    state.executeInContext.mockImplementation(async () => {
      throw new WalletNotFoundError('wallet');
    });

    await expect(state.useCase.execute(envelope)).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    expect(state.saved).toHaveLength(0);
    expect(state.events).toEqual(['begin']);
  });
});
