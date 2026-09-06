import { describe, expect, mock, spyOn, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import { InsufficientFundsError } from '../../../../src/wallet/domain/errors/wallet.errors.js';
import { LedgerDirection } from '../../../../src/wallet/domain/ledger-direction.js';
import { Wallet, type WalletBalanceChange } from '../../../../src/wallet/domain/wallet.js';
import type { WalletLedgerEntry } from '../../../../src/wallet/domain/wallet-ledger-entry.js';
import { InvalidWagerTransactionError } from '../../../../src/wagering/domain/errors/wager-transaction.errors.js';
import { FailureCode } from '../../../../src/wagering/domain/failure-code.js';
import { WagerTransaction } from '../../../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind as Kind } from '../../../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../../../src/wagering/domain/wager-transaction-status.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  WagerClaimConflictError,
  WagerResultUnavailableError,
  UnsupportedWagerTransactionKindError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../../../src/wagering/application/errors/wager-processing.errors.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../../../src/wagering/application/process-wager-transaction.use-case.js';
import type {
  WagerProcessingContext,
  WagerProcessingPersistence,
} from '../../../../src/wagering/application/wager-processing.persistence.js';

import { WagerPayloadHasher } from '../../../../src/wagering/application/wager-payload-hasher.js';
import type { WagerBusinessPayload } from '../../../../src/wagering/application/wager-business-payload.js';
import type { StoredWagerResult, WagerResultSnapshot } from '../../../../src/wagering/application/wager-result-snapshot.js';
import type { OutboxMessage } from '../../../../src/messaging/outbox/domain/outbox-message.js';

function withPayload(input: ProcessWagerTransactionInput, changes: Partial<WagerBusinessPayload>): ProcessWagerTransactionInput {
  return { ...input, payload: { ...input.payload, ...changes } };
}

const openedAt = new Date('2026-09-04T12:00:00.000Z');
const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

function setup(balance = '100.00') {
  const wallet = Wallet.open({
    id: 'wallet-1', playerId: 'player-1', initialBalance: money(balance), openedAt,
  });
  const context = {
    wallets: {
      findByIdForUpdate: mock(async (_id: string): Promise<Wallet | undefined> => wallet),
      save: mock(async (_wallet: Wallet): Promise<void> => {}),
    },
    transactions: {
      hasProcessedReversal: mock(async (_reference: string, _kind: Kind) => false),
      claimNextPendingReference: mock(async () => undefined),
      tryClaim: mock(async (_transaction: WagerTransaction) => true),
      findByIdempotencyKey: mock(async (_key: string): Promise<StoredWagerResult | undefined> => undefined),
      findByProviderAndExternalTransactionId: mock(async (_provider: string, _external: string): Promise<WagerTransaction | undefined> => undefined),
      saveStateAndResult: mock(async (_transaction: WagerTransaction, _snapshot: WagerResultSnapshot): Promise<void> => {}),
    },
    ledger: {
      append: mock(async (_entry: WalletLedgerEntry): Promise<void> => {}),
      findByWalletAndTransactionId: mock(async (_wallet: string, _transaction: string): Promise<WalletLedgerEntry | undefined> => undefined),
    },
    outbox: {
      append: mock(async (_message: OutboxMessage) => {}),
      claimNextDue: mock(async () => undefined),
      save: mock(async () => {}),
    },
  } satisfies WagerProcessingContext;
  const persistence: WagerProcessingPersistence = {
    transactional: async <T>(work: (ctx: WagerProcessingContext) => Promise<T>): Promise<T> => work(context),
  };
  const input: ProcessWagerTransactionInput = {
    idempotencyKey: 'key-1',
    payload: {
      providerId: 'provider-1', externalTransactionId: 'external-1', walletId: wallet.id,
      playerId: wallet.playerId, roundId: 'round-1', gameId: 'game-1',
      kind: Kind.Bet, money: money('25.00'),
    },
  };
  return { wallet, context, persistence, input, useCase: new ProcessWagerTransactionUseCase(persistence) };
}

function expectNoWalletWrites(context: ReturnType<typeof setup>['context']): void {
  expect(context.wallets.save).not.toHaveBeenCalled();
  expect(context.ledger.append).not.toHaveBeenCalled();
}

describe('ProcessWagerTransactionUseCase', () => {
  test.each([
    [Kind.Bet, 'debit', LedgerDirection.Debit, '75.00'],
    [Kind.Win, 'credit', LedgerDirection.Credit, '125.00'],
  ] as const)('%s uses the aggregate change for its ledger and a single timestamp', async (kind, method, direction, after) => {
    const { wallet, context, input, useCase } = setup();
    const apply = wallet[method].bind(wallet);
    let change: WalletBalanceChange | undefined;
    const movement = spyOn(wallet, method).mockImplementation((amount, at) => {
      change = apply(amount, at);
      return change;
    });
    const before = wallet.balance;
    const result = await useCase.execute(withPayload(input, { kind }));
    const transaction = context.transactions.saveStateAndResult.mock.calls[0]?.[0];
    const entry = context.ledger.append.mock.calls[0]?.[0];

    expect(context.wallets.findByIdForUpdate).toHaveBeenCalledWith(wallet.id);
    expect(movement).toHaveBeenCalledTimes(1);
    expect(context.wallets.save).toHaveBeenCalledWith(wallet);
    expect(context.transactions.saveStateAndResult).toHaveBeenCalledTimes(1);
    expect(context.ledger.append).toHaveBeenCalledTimes(1);
    expect(context.outbox.append.mock.calls.map(([message]) => message.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(result.status).toBe(Status.Processed);
    expect(transaction?.id).toBe(result.transactionId);
    expect(result.idempotentReplay).toBe(false);
    expect(result.balance.toJSON().amount).toBe(after);
    expect(result.walletVersion).toBe(2);
    expect(result.failureCode).toBeUndefined();
    expect(result.ledgerEntryId).toBe(entry?.id);
    expect(entry?.direction).toBe(direction);
    expect(entry?.money).toBe(input.payload.money);
    expect(entry?.balanceBefore).toBe(before);
    expect(entry?.balanceBefore).toBe(change?.balanceBefore);
    expect(entry?.balanceAfter).toBe(change?.balanceAfter);
    expect(entry?.balanceAfter).toBe(result.balance);
    expect(entry?.createdAt).toEqual(transaction?.processedAt);
    expect(transaction?.processedAt).toEqual(wallet.updatedAt);
    expect(transaction?.createdAt).toBeInstanceOf(Date);
    expect(transaction?.payloadHash).toBe(new WagerPayloadHasher().hash({ ...input.payload, kind }));
    expect(transaction?.idempotencyKey).toBe(input.idempotencyKey);
    movement.mockRestore();
  });

  test('LOSS preserves its amount, balance, version and timestamp without a ledger', async () => {
    const { wallet, context, input, useCase } = setup();
    const result = await useCase.execute(withPayload(input, { kind: Kind.Loss }));

    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.saveStateAndResult.mock.calls[0]?.[0].money).toBe(input.payload.money);
    expect(context.outbox.append.mock.calls.map(([message]) => message.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);
    expectNoWalletWrites(context);
  });

  test('insufficient BET is saved as REJECTED with no wallet or ledger writes', async () => {
    const { wallet, context, input, useCase } = setup('20.00');
    const result = await useCase.execute(input);

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance.toJSON().amount).toBe('20.00');
    expect(result.walletVersion).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.saveStateAndResult.mock.calls[0]?.[0].status).toBe(Status.Rejected);
    expect(context.transactions.saveStateAndResult.mock.calls[0]?.[0].processedAt).toBeUndefined();
    expect(context.outbox.append.mock.calls.map(([message]) => message.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
    expectNoWalletWrites(context);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s rejects currency mismatch without changing the wallet', async (kind) => {
    const { wallet, context, input, useCase } = setup();
    const result = await useCase.execute(withPayload(input, { kind, money: money('25.00', 'USD') }));

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.balance.currency).toBe('BRL');
    expect(result.walletVersion).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.saveStateAndResult.mock.calls[0]?.[0].failureCode).toBe(FailureCode.CurrencyMismatch);
    expectNoWalletWrites(context);
  });

  test.each([Kind.Opening, 'UNKNOWN' as Kind])('rejects unsupported runtime kind %s before persistence', async (kind) => {
    const { context, input, useCase } = setup();
    await expect(useCase.execute(withPayload(input, { kind }))).rejects.toBeInstanceOf(UnsupportedWagerTransactionKindError);
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expect(context.transactions.saveStateAndResult).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test('missing wallet is an application error with no writes', async () => {
    const { context, input, useCase } = setup();
    context.wallets.findByIdForUpdate.mockResolvedValue(undefined);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(context.transactions.saveStateAndResult).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s validates the wallet player before financial effects', async (kind) => {
    const { wallet, context, input, useCase } = setup();
    await expect(useCase.execute(withPayload(input, { kind, playerId: 'another-player' }))).rejects.toBeInstanceOf(WalletPlayerMismatchError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(context.transactions.saveStateAndResult).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test.each([Kind.Bet, Kind.Win])('%s zero is PROCESSED without financial writes', async (kind) => {
    const { wallet, context, input, useCase } = setup();
    const result = await useCase.execute(withPayload(input, { kind, money: Money.zero('BRL') }));
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(result.ledgerEntryId).toBeUndefined();
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(context.transactions.saveStateAndResult).toHaveBeenCalledTimes(1);
    expect(context.outbox.append.mock.calls.map(([message]) => message.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);
    expectNoWalletWrites(context);
  });

  test('WIN preserves an optional external reference without resolving it', async () => {
    const { context, input, useCase } = setup();
    await useCase.execute(withPayload(input, { kind: Kind.Win, referenceExternalTransactionId: 'external-bet' }));
    const transaction = context.transactions.saveStateAndResult.mock.calls[0]?.[0];
    expect(transaction?.status).toBe(Status.Processed);
    expect(transaction?.referenceExternalTransactionId).toBe('external-bet');
    expect(transaction?.referenceTransactionId).toBeUndefined();
  });

  test('delegates input validation to WagerTransaction.create', async () => {
    const { context, input, useCase } = setup();
    await expect(useCase.execute({ ...input, idempotencyKey: '' })).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expect(context.transactions.saveStateAndResult).not.toHaveBeenCalled();
  });

  test('unexpected aggregate errors propagate without recording a rejection', async () => {
    const { wallet, context, input, useCase } = setup();
    const error = new Error('unexpected domain failure');
    const debit = spyOn(wallet, 'debit').mockImplementation(() => { throw error; });
    try {
      await expect(useCase.execute(input)).rejects.toBe(error);
      expect(context.transactions.saveStateAndResult).not.toHaveBeenCalled();
      expectNoWalletWrites(context);
    } finally {
      debit.mockRestore();
    }
  });

  test('does not mistake repository exceptions for a business rejection', async () => {
    const { context, input, useCase } = setup();
    const error = new InsufficientFundsError();
    context.ledger.append.mockRejectedValue(error);
    await expect(useCase.execute(input)).rejects.toBe(error);
    expect(context.transactions.saveStateAndResult).toHaveBeenCalledTimes(1);
    expect(context.transactions.saveStateAndResult.mock.calls[0]?.[0].status).toBe(Status.Processed);
  });

  test('propagates a commit failure instead of returning success or retrying', async () => {
    const { context, input } = setup();
    const error = new Error('commit failed');
    const persistence: WagerProcessingPersistence = {
      transactional: async (work) => {
        await work(context);
        throw error;
      },
    };
    await expect(new ProcessWagerTransactionUseCase(persistence).execute(input)).rejects.toBe(error);
    expect(context.transactions.saveStateAndResult).toHaveBeenCalledTimes(1);
  });

  test('awaits the persistent claim before attempting a wallet lock', async () => {
    const { context, input, useCase } = setup();
    const claim = Promise.withResolvers<boolean>();
    context.transactions.tryClaim.mockImplementation(() => claim.promise);
    const execution = useCase.execute(input);
    expect(context.transactions.tryClaim).toHaveBeenCalledTimes(1);
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    claim.resolve(true);
    expect((await execution).idempotentReplay).toBe(false);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s replays the original snapshot and ledger ID without financial calls', async (kind) => {
    const { wallet, context, input: base, useCase } = setup();
    const input = withPayload(base, { kind });
    const first = await useCase.execute(input);
    const saved = context.transactions.saveStateAndResult.mock.calls[0];
    if (saved === undefined) throw new Error('Expected a saved original result');
    const entry = context.ledger.append.mock.calls[0]?.[0];
    context.transactions.tryClaim.mockResolvedValue(false);
    context.transactions.findByIdempotencyKey.mockResolvedValue({ transaction: saved[0], snapshot: saved[1] });
    context.ledger.findByWalletAndTransactionId.mockResolvedValue(entry);
    wallet.credit(money('100.00'), new Date());
    context.wallets.findByIdForUpdate.mockClear();
    context.wallets.save.mockClear();
    context.ledger.append.mockClear();
    context.transactions.saveStateAndResult.mockClear();
    const originalOutboxCount = context.outbox.append.mock.calls.length;
    const debit = spyOn(wallet, 'debit');
    const credit = spyOn(wallet, 'credit');
    try {
      const replay = await useCase.execute(input);
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
      expect(context.transactions.saveStateAndResult).not.toHaveBeenCalled();
      expect(debit).not.toHaveBeenCalled();
      expect(credit).not.toHaveBeenCalled();
      expectNoWalletWrites(context);
      expect(context.outbox.append).toHaveBeenCalledTimes(originalOutboxCount);
      const candidates = context.transactions.tryClaim.mock.calls.map(([candidate]) => candidate);
      expect(new Set(candidates.map(({ id }) => id)).size).toBe(2);
      expect(candidates[0]?.payloadHash).toBe(candidates[1]?.payloadHash);
    } finally {
      debit.mockRestore();
      credit.mockRestore();
    }
  });

  test('payload conflict is classified before any wallet lock or writes', async () => {
    const { context, input, useCase } = setup();
    const original = WagerTransaction.create({ ...input.payload, id: 'original', idempotencyKey: input.idempotencyKey, payloadHash: 'different-hash' });
    context.transactions.tryClaim.mockResolvedValue(false);
    context.transactions.findByIdempotencyKey.mockResolvedValue({ transaction: original, snapshot: undefined });
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expect(context.transactions.saveStateAndResult).not.toHaveBeenCalled();
    expect(context.transactions.findByProviderAndExternalTransactionId).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test.each([Status.Pending, Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed])(
    '%s without a snapshot is explicitly unavailable and never reprocessed', async (status) => {
      const { context, input, useCase } = setup();
      const original = WagerTransaction.rehydrate({
        ...input.payload, id: 'legacy', idempotencyKey: input.idempotencyKey, payloadHash: new WagerPayloadHasher().hash(input.payload),
        createdAt: openedAt, status, referenceExternalTransactionId: undefined,
        referenceTransactionId: undefined, failureCode: undefined, processedAt: undefined,
      });
      context.transactions.tryClaim.mockResolvedValue(false);
      context.transactions.findByIdempotencyKey.mockResolvedValue({ transaction: original, snapshot: undefined });
      await expect(useCase.execute(input)).rejects.toBeInstanceOf(WagerResultUnavailableError);
      expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
      expectNoWalletWrites(context);
    },
  );

  test('FAILED with a snapshot returns the saved failure without terminal transitions', async () => {
    const { context, input, useCase } = setup();
    const original = WagerTransaction.create({ ...input.payload, id: 'failed', idempotencyKey: input.idempotencyKey, payloadHash: new WagerPayloadHasher().hash(input.payload) });
    original.fail(FailureCode.PermanentInfrastructureFailure);
    context.transactions.tryClaim.mockResolvedValue(false);
    context.transactions.findByIdempotencyKey.mockResolvedValue({ transaction: original, snapshot: { balance: money('7.00'), walletVersion: 3 } });
    const result = await useCase.execute(input);
    expect(result).toMatchObject({ transactionId: 'failed', status: Status.Failed, failureCode: FailureCode.PermanentInfrastructureFailure, walletVersion: 3, idempotentReplay: true });
    expect(result.balance.toJSON().amount).toBe('7.00');
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });

  test('classifies provider/external and structural claim conflicts explicitly', async () => {
    const { context, input, useCase } = setup();
    context.transactions.tryClaim.mockResolvedValue(false);
    const original = WagerTransaction.create({ ...input.payload, id: 'external', idempotencyKey: 'other-key', payloadHash: 'hash' });
    context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(original);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(ExternalTransactionConflictError);
    context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(undefined);
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(WagerClaimConflictError);
    expect(context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expectNoWalletWrites(context);
  });
});
