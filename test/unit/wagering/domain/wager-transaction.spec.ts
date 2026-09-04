import { describe, expect, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/value-objects/money.js';
import {
  InvalidRollbackReferenceError,
  InvalidTransactionStateError,
  MissingTransactionReferenceError,
  TransactionHasNoLedgerDirectionError,
} from '../../../../src/wagering/domain/errors/wager-transaction.errors.js';
import { FailureCode } from '../../../../src/wagering/domain/failure-code.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../../../src/wagering/domain/wager-transaction.js';
import { WagerTransactionKind } from '../../../../src/wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../../src/wagering/domain/wager-transaction-status.js';
import { LedgerDirection } from '../../../../src/wallet/domain/ledger-direction.js';

const createdAt = new Date('2026-09-04T10:00:00.000Z');
const processedAt = new Date('2026-09-04T10:01:00.000Z');

const baseProps = {
  id: 'transaction-1',
  providerId: 'provider-1',
  externalTransactionId: 'external-1',
  idempotencyKey: 'provider-1:external-1',
  payloadHash: 'payload-hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  createdAt,
} satisfies Omit<
  CreateWagerTransactionProps,
  'kind' | 'referenceExternalTransactionId'
>;

function createTransaction(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    ...baseProps,
    kind,
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
  });
}

function rehydrateTerminal(
  status: WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    ...baseProps,
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'bet-external-1',
    status,
    referenceTransactionId:
      status === WagerTransactionStatus.Processed ? 'bet-1' : undefined,
    failureCode:
      status === WagerTransactionStatus.Rejected ||
      status === WagerTransactionStatus.Failed
        ? FailureCode.InvalidReference
        : undefined,
    processedAt:
      status === WagerTransactionStatus.Processed ? processedAt : undefined,
  });
}

describe('WagerTransaction', () => {
  test('creates in PENDING and preserves its properties', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    expect(transaction.id).toBe(baseProps.id);
    expect(transaction.providerId).toBe(baseProps.providerId);
    expect(transaction.externalTransactionId).toBe(
      baseProps.externalTransactionId,
    );
    expect(transaction.idempotencyKey).toBe(baseProps.idempotencyKey);
    expect(transaction.payloadHash).toBe(baseProps.payloadHash);
    expect(transaction.walletId).toBe(baseProps.walletId);
    expect(transaction.playerId).toBe(baseProps.playerId);
    expect(transaction.roundId).toBe(baseProps.roundId);
    expect(transaction.gameId).toBe(baseProps.gameId);
    expect(transaction.kind).toBe(WagerTransactionKind.Bet);
    expect(transaction.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(transaction.createdAt).toEqual(createdAt);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s requires referenceExternalTransactionId',
    (kind) => {
      expect(() => createTransaction(kind)).toThrow(
        MissingTransactionReferenceError,
      );
    },
  );

  test('WIN accepts both absent and present references', () => {
    expect(
      createTransaction(WagerTransactionKind.Win)
        .referenceExternalTransactionId,
    ).toBeUndefined();
    expect(
      createTransaction(WagerTransactionKind.Win, 'bet-external-1')
        .referenceExternalTransactionId,
    ).toBe('bet-external-1');
  });

  test.each([
    [WagerTransactionStatus.Pending, false],
    [WagerTransactionStatus.PendingReference, false],
    [WagerTransactionStatus.Processed, true],
    [WagerTransactionStatus.Rejected, true],
    [WagerTransactionStatus.Failed, true],
  ] as const)('reports terminality for %s', (status, expected) => {
    const transaction = WagerTransaction.rehydrate({
      ...baseProps,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-external-1',
      status,
      referenceTransactionId: undefined,
      failureCode:
        status === WagerTransactionStatus.Rejected ||
        status === WagerTransactionStatus.Failed
          ? FailureCode.InvalidReference
          : undefined,
      processedAt:
        status === WagerTransactionStatus.Processed ? processedAt : undefined,
    });

    expect(transaction.isTerminal()).toBe(expected);
  });

  test('marks a transaction as processed with its resolved reference and date', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Refund,
      'bet-external-1',
    );

    transaction.markProcessed('bet-1', processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('bet-1');
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.createdAt).toEqual(createdAt);
    expect(transaction.payloadHash).toBe(baseProps.payloadHash);
    expect(transaction.money).toBe(baseProps.money);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s cannot be processed without a resolved internal reference',
    (kind) => {
      const transaction = createTransaction(kind, 'bet-external-1');

      expect(() => transaction.markProcessed(undefined, processedAt)).toThrow(
        MissingTransactionReferenceError,
      );
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.referenceTransactionId).toBeUndefined();
      expect(transaction.processedAt).toBeUndefined();
    },
  );

  test.each([
    WagerTransactionKind.Opening,
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
  ])('%s can be processed without an internal reference', (kind) => {
    const transaction = createTransaction(kind);

    transaction.markProcessed(undefined, processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.processedAt).toEqual(processedAt);
  });

  test('WIN can also be processed with an optional internal reference', () => {
    const transaction = createTransaction(WagerTransactionKind.Win);

    transaction.markProcessed('bet-1', processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('bet-1');
  });

  test('moves reference-dependent transactions to PENDING_REFERENCE', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Rollback,
      'bet-external-1',
    );

    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);

    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('does not allow a reference-free kind to become PENDING_REFERENCE', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    expect(() => transaction.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  test('rejects with a stable failure code', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    transaction.reject(FailureCode.InsufficientFunds);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('fails with a stable failure code', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    transaction.fail(FailureCode.PermanentInfrastructureFailure);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(
      FailureCode.PermanentInfrastructureFailure,
    );
  });

  test.each([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ] as const)('blocks every transition after reaching %s', (status) => {
    const transitions: ReadonlyArray<(transaction: WagerTransaction) => void> = [
      (transaction) => transaction.markProcessed('bet-1', processedAt),
      (transaction) => transaction.markPendingReference(),
      (transaction) => transaction.reject(FailureCode.InvalidReference),
      (transaction) =>
        transaction.fail(FailureCode.PermanentInfrastructureFailure),
    ];

    for (const transition of transitions) {
      expect(() => transition(rehydrateTerminal(status))).toThrow(
        InvalidTransactionStateError,
      );
    }
  });

  test('matches payload hashes exactly', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    expect(transaction.matchesPayload('payload-hash-1')).toBe(true);
    expect(transaction.matchesPayload('PAYLOAD-HASH-1')).toBe(false);
    expect(transaction.matchesPayload('payload-hash-2')).toBe(false);
  });

  test.each([
    [WagerTransactionKind.Opening, true],
    [WagerTransactionKind.Bet, true],
    [WagerTransactionKind.Win, true],
    [WagerTransactionKind.Loss, false],
    [WagerTransactionKind.Refund, true],
    [WagerTransactionKind.Rollback, true],
  ] as const)('reports whether %s affects balance', (kind, expected) => {
    const reference =
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
        ? 'reference-1'
        : undefined;

    expect(createTransaction(kind, reference).affectsBalance()).toBe(expected);
  });

  test.each([
    [WagerTransactionKind.Opening, false],
    [WagerTransactionKind.Bet, false],
    [WagerTransactionKind.Win, false],
    [WagerTransactionKind.Loss, false],
    [WagerTransactionKind.Refund, true],
    [WagerTransactionKind.Rollback, true],
  ] as const)('reports whether %s requires a reference', (kind, expected) => {
    const reference = expected ? 'reference-1' : undefined;
    expect(createTransaction(kind, reference).requiresReference()).toBe(
      expected,
    );
  });

  test.each([
    [WagerTransactionKind.Opening, LedgerDirection.Credit],
    [WagerTransactionKind.Bet, LedgerDirection.Debit],
    [WagerTransactionKind.Win, LedgerDirection.Credit],
    [WagerTransactionKind.Refund, LedgerDirection.Credit],
  ] as const)('maps %s to %s', (kind, expected) => {
    const reference =
      kind === WagerTransactionKind.Refund ? 'reference-1' : undefined;
    expect(createTransaction(kind, reference).ledgerDirectionFor()).toBe(
      expected,
    );
  });

  test.each([
    [WagerTransactionKind.Bet, LedgerDirection.Credit],
    [WagerTransactionKind.Win, LedgerDirection.Debit],
    [WagerTransactionKind.Refund, LedgerDirection.Debit],
  ] as const)(
    'inverts %s when calculating a ROLLBACK direction',
    (referenceKind, expected) => {
      const rollback = createTransaction(
        WagerTransactionKind.Rollback,
        'reference-1',
      );
      const reference = createTransaction(
        referenceKind,
        referenceKind === WagerTransactionKind.Refund
          ? 'original-bet-1'
          : undefined,
      );

      expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
    },
  );

  test('rejects a ledger direction for LOSS', () => {
    expect(() =>
      createTransaction(WagerTransactionKind.Loss).ledgerDirectionFor(),
    ).toThrow(TransactionHasNoLedgerDirectionError);
  });

  test('requires the resolved transaction to calculate ROLLBACK direction', () => {
    expect(() =>
      createTransaction(
        WagerTransactionKind.Rollback,
        'reference-1',
      ).ledgerDirectionFor(),
    ).toThrow(MissingTransactionReferenceError);
  });

  test.each([
    WagerTransactionKind.Opening,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Rollback,
  ] as const)('rejects %s as a ROLLBACK reference', (referenceKind) => {
    const rollback = createTransaction(
      WagerTransactionKind.Rollback,
      'reference-1',
    );
    const reference = createTransaction(
      referenceKind,
      referenceKind === WagerTransactionKind.Rollback
        ? 'nested-reference-1'
        : undefined,
    );

    expect(() => rollback.ledgerDirectionFor(reference)).toThrow(
      InvalidRollbackReferenceError,
    );
  });

  test('rehydrates persisted terminal state without replaying transitions', () => {
    const transaction = rehydrateTerminal(WagerTransactionStatus.Processed);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('bet-1');
    expect(transaction.processedAt).toEqual(processedAt);
  });
});
