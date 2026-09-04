import { Money } from '../../shared/domain/value-objects/money.js';
import { LedgerDirection } from '../../wallet/domain/ledger-direction.js';
import {
  InvalidRollbackReferenceError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  MissingTransactionReferenceError,
  TransactionHasNoLedgerDirectionError,
  type WagerTransactionField,
  type WagerTransactionTransition,
} from './errors/wager-transaction.errors.js';
import { FailureCode } from './failure-code.js';
import { WagerTransactionKind } from './wager-transaction-kind.js';
import { WagerTransactionStatus } from './wager-transaction-status.js';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
  ) {}

  static create({
    id,
    providerId,
    externalTransactionId,
    idempotencyKey,
    payloadHash,
    walletId,
    playerId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId,
    createdAt = new Date(),
  }: CreateWagerTransactionProps): WagerTransaction {
    const identifiers: ReadonlyArray<
      readonly [string, Exclude<WagerTransactionField, 'money' | 'createdAt' | 'processedAt'>]
    > = [
      [id, 'id'],
      [providerId, 'providerId'],
      [externalTransactionId, 'externalTransactionId'],
      [idempotencyKey, 'idempotencyKey'],
      [payloadHash, 'payloadHash'],
      [walletId, 'walletId'],
      [playerId, 'playerId'],
      [roundId, 'roundId'],
      [gameId, 'gameId'],
    ];

    for (const [value, field] of identifiers) {
      WagerTransaction.assertValidIdentifier(value, field);
    }

    if (!(money instanceof Money) || money.isNegative()) {
      throw new InvalidWagerTransactionError('money');
    }

    const creationDate = WagerTransaction.copyValidDate(createdAt, 'createdAt');

    if (referenceExternalTransactionId !== undefined) {
      WagerTransaction.assertValidIdentifier(
        referenceExternalTransactionId,
        'referenceExternalTransactionId',
      );
    }

    if (
      (kind === WagerTransactionKind.Refund ||
        kind === WagerTransactionKind.Rollback) &&
      referenceExternalTransactionId === undefined
    ) {
      throw new MissingTransactionReferenceError(kind);
    }

    return new WagerTransaction(
      id,
      providerId,
      externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId,
      playerId,
      roundId,
      gameId,
      kind,
      money,
      referenceExternalTransactionId,
      creationDate,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined
        ? undefined
        : new Date(state.processedAt.getTime()),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined
      ? undefined
      : new Date(this._processedAt.getTime());
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition('markProcessed');

    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new MissingTransactionReferenceError(this.kind);
    }

    if (referenceTransactionId !== undefined) {
      WagerTransaction.assertValidIdentifier(
        referenceTransactionId,
        'referenceTransactionId',
      );
    }

    const processedAt = WagerTransaction.copyValidDate(at, 'processedAt');

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = processedAt;
  }

  markPendingReference(): void {
    this.assertCanTransition('markPendingReference');

    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        this._status,
        'markPendingReference',
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertCanTransition('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new TransactionHasNoLedgerDirectionError(this.kind);
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new MissingTransactionReferenceError(this.kind);
        }

        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }

        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }

        throw new InvalidRollbackReferenceError(reference.kind);
    }
  }

  private assertCanTransition(transition: WagerTransactionTransition): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, transition);
    }
  }

  private static assertValidIdentifier(
    value: unknown,
    field: Exclude<WagerTransactionField, 'money' | 'createdAt' | 'processedAt'>,
  ): asserts value is string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value
    ) {
      throw new InvalidWagerTransactionError(field);
    }
  }

  private static copyValidDate(
    date: Date,
    field: 'createdAt' | 'processedAt',
  ): Date {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new InvalidWagerTransactionError(field);
    }

    return new Date(date.getTime());
  }
}
