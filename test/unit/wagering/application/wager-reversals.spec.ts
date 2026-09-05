import { describe, expect, mock, spyOn, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import { Wallet, type WalletBalanceChange } from '../../../../src/wallet/domain/wallet.js';
import type { WalletLedgerEntry } from '../../../../src/wallet/domain/wallet-ledger-entry.js';
import { LedgerDirection } from '../../../../src/wallet/domain/ledger-direction.js';
import { WagerTransaction } from '../../../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind as Kind } from '../../../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../../../src/wagering/domain/wager-transaction-status.js';
import { FailureCode } from '../../../../src/wagering/domain/failure-code.js';
import { ClaimedWagerTransactionProcessor } from '../../../../src/wagering/application/claimed-wager-transaction.processor.js';
import { PendingReferenceRetryPolicy, type PendingReferenceRetryState } from '../../../../src/wagering/application/pending-reference-retry-policy.js';
import { PendingReferenceWorker } from '../../../../src/wagering/application/pending-reference.worker.js';
import { ProcessWagerTransactionUseCase } from '../../../../src/wagering/application/process-wager-transaction.use-case.js';
import type { WagerProcessingContext, WagerProcessingPersistence } from '../../../../src/wagering/application/wager-processing.persistence.js';
import type { PendingReferenceWork, StoredWagerResult, WagerResultSnapshot } from '../../../../src/wagering/application/wager-result-snapshot.js';
import { WagerPayloadHasher } from '../../../../src/wagering/application/wager-payload-hasher.js';

const now = new Date('2026-09-05T12:00:00Z');
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

function setup(kind = Kind.Refund, balance = '100.00', policy = new PendingReferenceRetryPolicy()) {
  const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: money(balance), openedAt: now });
  const payload = {
    providerId: 'provider', externalTransactionId: 'reversal', walletId: wallet.id,
    playerId: wallet.playerId, roundId: 'round', gameId: 'game', kind,
    money: money('25.00'), referenceExternalTransactionId: 'reference',
  };
  const input = { idempotencyKey: 'key', payload };
  const transaction = WagerTransaction.create({ ...payload, id: 'reversal-id', idempotencyKey: input.idempotencyKey, payloadHash: new WagerPayloadHasher().hash(payload), createdAt: now });
  const reference = (referenceKind = Kind.Bet, status = Status.Processed, overrides = {}) => {
    return WagerTransaction.rehydrate({
      ...payload, id: 'reference-id', externalTransactionId: 'reference',
      idempotencyKey: 'ref-key', payloadHash: 'ref-hash', kind: referenceKind,
      status, createdAt: now, processedAt: status === Status.Processed ? now : undefined,
      referenceTransactionId: undefined, failureCode: undefined, ...overrides,
    });
  };
  const context = {
    wallets: {
      findByIdForUpdate: mock(async (_id: string): Promise<Wallet | undefined> => wallet),
      save: mock(async (_wallet: Wallet) => {}),
    },
    transactions: {
      tryClaim: mock(async (_transaction: WagerTransaction) => true),
      findByIdempotencyKey: mock(async (_key: string): Promise<StoredWagerResult | undefined> => undefined),
      findByProviderAndExternalTransactionId: mock(async (_provider: string, _external: string): Promise<WagerTransaction | undefined> => reference()),
      hasProcessedReversal: mock(async (_id: string, _kind: Kind) => false),
      claimNextPendingReference: mock(async (_now: Date): Promise<PendingReferenceWork | undefined> => undefined),
      saveStateAndResult: mock(async (_transaction: WagerTransaction, _snapshot: WagerResultSnapshot, _retry?: PendingReferenceRetryState) => {}),
    },
    ledger: {
      append: mock(async (_entry: WalletLedgerEntry) => {}),
      findByWalletAndTransactionId: mock(async (_wallet: string, _id: string): Promise<WalletLedgerEntry | undefined> => undefined),
    },
  } satisfies WagerProcessingContext;
  const persistence: WagerProcessingPersistence = { transactional: async (work) => work(context) };
  const processor = new ClaimedWagerTransactionProcessor(policy);
  const process = () => processor.process(context, transaction, undefined, now);
  const pending = (): PendingReferenceWork => {
    const saved = context.transactions.saveStateAndResult.mock.calls.at(-1);
    if (saved?.[2] === undefined) throw new Error('Expected retry metadata');
    return { transaction: saved[0], snapshot: saved[1], retryState: saved[2] };
  };
  return { wallet, transaction, reference, context, persistence, processor, process, pending, input };
}

describe('reversals under the wallet lock', () => {
  test.each([
    [Kind.Refund, Kind.Bet, 'credit', LedgerDirection.Credit, '125.00'],
    [Kind.Rollback, Kind.Bet, 'credit', LedgerDirection.Credit, '125.00'],
    [Kind.Rollback, Kind.Win, 'debit', LedgerDirection.Debit, '75.00'],
    [Kind.Rollback, Kind.Refund, 'debit', LedgerDirection.Debit, '75.00'],
  ] as const)('%s of %s uses the Wallet change and domain direction', async (kind, refKind, method, direction, amount) => {
    const s = setup(kind);
    const ref = s.reference(refKind);
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(ref);
    let change: WalletBalanceChange | undefined;
    const original = s.wallet[method].bind(s.wallet);
    const movement = spyOn(s.wallet, method).mockImplementation((value, at) => { change = original(value, at); return change; });
    const directionSpy = spyOn(s.transaction, 'ledgerDirectionFor');
    const result = await s.process();
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.toJSON().amount).toBe(amount);
    expect(result.walletVersion).toBe(2);
    expect(s.transaction.referenceTransactionId).toBe(ref.id);
    expect(movement).toHaveBeenCalledTimes(1);
    expect(directionSpy).toHaveBeenCalledWith(ref);
    const entry = s.context.ledger.append.mock.calls[0]?.[0];
    expect(entry?.direction).toBe(direction);
    expect(entry?.balanceBefore).toBe(change?.balanceBefore);
    expect(entry?.balanceAfter).toBe(change?.balanceAfter);
    expect(entry?.createdAt).toEqual(now);
    expect(s.context.transactions.findByProviderAndExternalTransactionId).toHaveBeenCalledWith('provider', 'reference');
  });

  test.each([Kind.Refund, Kind.Rollback])('%s rejects unequal amounts without movement', async (kind) => {
    const s = setup(kind);
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(s.reference(Kind.Bet, Status.Processed, { money: money('20.00') }));
    const result = await s.process();
    expect(result.failureCode).toBe(FailureCode.ReversalAmountMismatch);
    expect(result.walletVersion).toBe(1);
    expect(s.context.wallets.save).not.toHaveBeenCalled();
    expect(s.context.ledger.append).not.toHaveBeenCalled();
    expect(s.context.transactions.hasProcessedReversal).not.toHaveBeenCalled();
  });

  test.each([
    [Kind.Refund, Kind.Win], [Kind.Refund, Kind.Refund],
    [Kind.Rollback, Kind.Loss], [Kind.Rollback, Kind.Opening], [Kind.Rollback, Kind.Rollback],
  ] as const)('%s cannot reference %s', async (kind, refKind) => {
    const s = setup(kind);
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(s.reference(refKind));
    expect((await s.process()).failureCode).toBe(FailureCode.InvalidReference);
    expect(s.context.ledger.append).not.toHaveBeenCalled();
  });

  test.each([
    { providerId: 'another' }, { playerId: 'another' }, { walletId: 'another' },
    { roundId: 'another' }, { money: money('25.00', 'USD') }, { id: 'reversal-id' },
  ])('rejects incompatible reference context %j', async (overrides) => {
    const s = setup();
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(s.reference(Kind.Bet, Status.Processed, overrides));
    expect((await s.process()).failureCode).toBe(FailureCode.InvalidReference);
    expect(s.context.ledger.append).not.toHaveBeenCalled();
  });

  test('gameId is not part of reference compatibility', async () => {
    const s = setup();
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(s.reference(Kind.Bet, Status.Processed, { gameId: 'another-game' }));
    expect((await s.process()).status).toBe(Status.Processed);
  });

  test.each([Status.Rejected, Status.Failed])('terminal %s reference is INVALID_REFERENCE', async (status) => {
    const s = setup();
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(s.reference(Kind.Bet, status));
    expect((await s.process()).failureCode).toBe(FailureCode.InvalidReference);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s rejects an existing processed reversal', async (kind) => {
    const s = setup(kind);
    s.context.transactions.hasProcessedReversal.mockResolvedValue(true);
    expect((await s.process()).failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(s.context.transactions.hasProcessedReversal).toHaveBeenCalledWith('reference-id', kind);
    expect(s.context.ledger.append).not.toHaveBeenCalled();
  });

  test.each([Kind.Win, Kind.Refund])('ROLLBACK of %s cannot make balance negative', async (refKind) => {
    const s = setup(Kind.Rollback, '20.00');
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(s.reference(refKind));
    const result = await s.process();
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReversalWouldMakeBalanceNegative);
    expect(result.balance.toJSON().amount).toBe('20.00');
    expect(result.walletVersion).toBe(1);
    expect(s.context.wallets.save).not.toHaveBeenCalled();
    expect(s.context.ledger.append).not.toHaveBeenCalled();
  });

  test.each([Kind.Refund, Kind.Rollback])('%s checks operation currency before resolving the reference', async (kind) => {
    const s = setup(kind);
    const useCase = new ProcessWagerTransactionUseCase(s.persistence);
    const result = await useCase.execute({ ...s.input, payload: { ...s.input.payload, money: money('25.00', 'USD') } });
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(s.context.transactions.findByProviderAndExternalTransactionId).not.toHaveBeenCalled();
    expect(s.context.ledger.append).not.toHaveBeenCalled();
  });
});

describe('pending reference worker and replay', () => {
  test.each([undefined, Status.Pending, Status.PendingReference])('unresolved reference %s persists pending with initial snapshot', async (status) => {
    const s = setup(Kind.Rollback);
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(status === undefined ? undefined : s.reference(Kind.Refund, status));
    const result = await s.process();
    expect(result.status).toBe(Status.PendingReference);
    expect(s.pending().retryState).toEqual({ attemptCount: 1, nextAttemptAt: new Date(now.getTime() + 1_000), deadlineAt: new Date(now.getTime() + 86_400_000) });
    expect(result.balance.toJSON().amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(s.context.wallets.save).not.toHaveBeenCalled();
    expect(s.context.ledger.append).not.toHaveBeenCalled();
  });

  test('pending replay performs no new resolution, job claim, financial lock or ledger read', async () => {
    const s = setup();
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(undefined);
    const first = await s.process();
    s.context.transactions.tryClaim.mockResolvedValue(false);
    s.context.transactions.findByIdempotencyKey.mockResolvedValue(s.pending());
    s.context.transactions.findByProviderAndExternalTransactionId.mockClear();
    s.context.wallets.findByIdForUpdate.mockClear();
    const replay = await new ProcessWagerTransactionUseCase(s.persistence).execute(s.input);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(s.context.transactions.findByProviderAndExternalTransactionId).not.toHaveBeenCalled();
    expect(s.context.transactions.claimNextPendingReference).not.toHaveBeenCalled();
    expect(s.context.wallets.findByIdForUpdate).not.toHaveBeenCalled();
    expect(s.context.ledger.findByWalletAndTransactionId).not.toHaveBeenCalled();
  });

  test('worker unresolved retry increments attempts and backoff, retaining deadline and original snapshot', async () => {
    const s = setup();
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(undefined);
    const first = await s.process();
    const pending = s.pending();
    s.wallet.credit(money('10.00'), now);
    s.context.transactions.claimNextPendingReference.mockResolvedValueOnce(pending);
    const results = await new PendingReferenceWorker(s.persistence, s.processor).runOnce(new Date(now.getTime() + 1_000), 1);
    expect(results).toEqual([first]);
    expect(s.pending().retryState).toEqual({ attemptCount: 2, nextAttemptAt: new Date(now.getTime() + 3_000), deadlineAt: pending.retryState.deadlineAt });
    expect(s.context.transactions.tryClaim).not.toHaveBeenCalled();
  });

  test('worker resolves the same transaction and clears scheduling, preserving audit attempts', async () => {
    const s = setup();
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValueOnce(undefined);
    await s.process();
    s.context.transactions.claimNextPendingReference.mockResolvedValueOnce(s.pending());
    const results = await new PendingReferenceWorker(s.persistence, s.processor).runOnce(new Date(now.getTime() + 1_000), 1);
    expect(results[0]).toMatchObject({ transactionId: s.transaction.id, status: Status.Processed, walletVersion: 2 });
    expect(s.transaction.referenceTransactionId).toBe('reference-id');
    expect(s.pending().retryState).toEqual({ attemptCount: 1, nextAttemptAt: null, deadlineAt: null });
    expect(s.context.transactions.tryClaim).not.toHaveBeenCalled();
    expect(s.context.ledger.append).toHaveBeenCalledTimes(1);
  });

  test.each(['attempts', 'TTL'])('worker rejects on exhausted %s and snapshots the final wallet', async (reason) => {
    const s = setup(Kind.Refund, '100.00', new PendingReferenceRetryPolicy({ maxAttempts: 2, ttlMs: 5_000 }));
    s.context.transactions.findByProviderAndExternalTransactionId.mockResolvedValue(undefined);
    await s.process();
    s.wallet.credit(money('10.00'), now);
    s.context.transactions.claimNextPendingReference.mockResolvedValueOnce(s.pending());
    const results = await new PendingReferenceWorker(s.persistence, s.processor).runOnce(new Date(now.getTime() + (reason === 'TTL' ? 5_000 : 1_000)), 1);
    expect(results[0]).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceNotFound, walletVersion: 2 });
    expect(results[0]?.balance.toJSON().amount).toBe('110.00');
    expect(s.pending().retryState).toEqual({ attemptCount: reason === 'TTL' ? 1 : 2, nextAttemptAt: null, deadlineAt: null });
    expect(s.context.ledger.append).not.toHaveBeenCalled();
  });

  test('local overlapping iteration is skipped; infrastructure error propagates and allows a later iteration', async () => {
    const s = setup();
    const gate = Promise.withResolvers<PendingReferenceWork | undefined>();
    s.context.transactions.claimNextPendingReference.mockImplementationOnce(() => gate.promise);
    const worker = new PendingReferenceWorker(s.persistence);
    const first = worker.runOnce(now);
    expect(await worker.runOnce(now)).toEqual([]);
    gate.reject(new Error('database unavailable'));
    await expect(first).rejects.toThrow('database unavailable');
    expect(await worker.runOnce(now)).toEqual([]);
    expect(s.context.transactions.claimNextPendingReference).toHaveBeenCalledTimes(2);
  });
});
