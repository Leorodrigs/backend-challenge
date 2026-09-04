import type { WagerTransactionKind } from '../wager-transaction-kind.js';
import type { WagerTransactionStatus } from '../wager-transaction-status.js';

export type WagerTransactionField =
  | 'id'
  | 'providerId'
  | 'externalTransactionId'
  | 'idempotencyKey'
  | 'payloadHash'
  | 'walletId'
  | 'playerId'
  | 'roundId'
  | 'gameId'
  | 'referenceExternalTransactionId'
  | 'referenceTransactionId'
  | 'money'
  | 'createdAt'
  | 'processedAt';

export type WagerTransactionTransition =
  | 'markProcessed'
  | 'markPendingReference'
  | 'reject'
  | 'fail';

export class InvalidWagerTransactionError extends Error {
  constructor(public readonly field: WagerTransactionField) {
    super(`Invalid wager transaction ${field}`);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(
    public readonly status: WagerTransactionStatus,
    public readonly transition: WagerTransactionTransition,
  ) {
    super(`Cannot ${transition} a transaction in ${status} status`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class MissingTransactionReferenceError extends Error {
  constructor(public readonly kind: WagerTransactionKind) {
    super(`${kind} requires a transaction reference`);
    this.name = 'MissingTransactionReferenceError';
  }
}

export class InvalidRollbackReferenceError extends Error {
  constructor(public readonly referenceKind: WagerTransactionKind) {
    super(`ROLLBACK cannot reference ${referenceKind}`);
    this.name = 'InvalidRollbackReferenceError';
  }
}

export class TransactionHasNoLedgerDirectionError extends Error {
  constructor(public readonly kind: WagerTransactionKind) {
    super(`${kind} has no ledger direction`);
    this.name = 'TransactionHasNoLedgerDirectionError';
  }
}
