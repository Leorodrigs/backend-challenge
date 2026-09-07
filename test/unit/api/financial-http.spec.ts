import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FinancialController } from '../../../src/api/financial.controller.js';
import { FinancialQueryPort } from '../../../src/api/financial-query.port.js';
import { FinancialExceptionFilter } from '../../../src/api/financial-exception.filter.js';
import { ProviderIdentityGuard } from '../../../src/api/provider-identity.guard.js';
import { CreateWalletUseCase } from '../../../src/wallet/application/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../../src/wagering/application/process-wager-transaction.use-case.js';
import { Money } from '../../../src/shared/domain/value-objects/money.js';
import { WagerTransactionStatus as Status } from '../../../src/wagering/domain/wager-transaction-status.js';
import { IdempotencyConflictError, ExternalTransactionConflictError } from '../../../src/wagering/application/errors/wager-processing.errors.js';
import { encodeCursor, parseLedgerQuery, parseWallet, parseWager } from '../../../src/api/transport-validation.js';

const body = { providerId: 'provider', externalTransactionId: 'external', walletId: 'wallet', playerId: 'player',
  roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
describe('strict financial HTTP transport', () => {
  let app: INestApplication;
  let base: string;
  let calls = 0;
  let status: Status = Status.Processed;
  let failure: unknown;
  beforeAll(async () => {
    @Module({ controllers: [FinancialController], providers: [
      ProviderIdentityGuard,
      { provide: APP_FILTER, useClass: FinancialExceptionFilter },
      { provide: CreateWalletUseCase, useValue: { execute: () => { throw new Error('Unexpected wallet write'); } } },
      { provide: FinancialQueryPort, useValue: { wallet: async () => undefined, transaction: async () => undefined, providerTransaction: async () => undefined } },
      { provide: ProcessWagerTransactionUseCase, useValue: { execute: async () => {
        calls++; if (failure) throw failure;
        return { transactionId: 'tx', status, balance: Money.from({ amount: '75.00', currency: 'BRL' }),
          walletVersion: 2, idempotentReplay: true, ...(status === Status.Rejected ? { failureCode: 'INSUFFICIENT_FUNDS' } : {}) };
      } } },
    ] }) class TestModule {}
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  }, 30000);
  afterAll(async () => { await app?.close(); }, 10000);
  async function submit(value: unknown, key?: string) {
    return fetch(`${base}/wagering/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }) }, body: JSON.stringify(value) });
  }
  test('invalid contracts never invoke the financial use case', async () => {
    const before = calls;
    for (const amount of [25, '25', '25.0', '25.000', '1e2', 'NaN', 'Infinity', '-1.00', '', null]) {
      expect((await submit({ ...body, money: { amount, currency: 'BRL' } }, 'key')).status).toBe(400);
    }
    for (const value of [null, [], { ...body, kind: 'OPENING' }, { ...body, kind: 'REFUND' },
      { ...body, money: { ...body.money, extra: true } }, { ...body, idempotencyKey: 'body' },
      { ...body, providerId: ' provider' }, { ...body, referenceExternalTransactionId: null }]) {
      expect((await submit(value, 'key')).status).toBe(400);
    }
    expect((await submit(body)).status).toBe(400);
    expect(calls).toBe(before);
  });
  test('processed, rejected and pending results retain exact historical money and meaningful statuses', async () => {
    for (const [state, expected] of [[Status.Processed, 200], [Status.Rejected, 422], [Status.PendingReference, 202], [Status.Pending, 202], [Status.Failed, 503]] as const) {
      status = state;
      const response = await submit(body, 'key'); expect(response.status).toBe(expected);
      const result: unknown = await response.json();
      expect(result).toMatchObject({ transactionId: 'tx', status: state, balance: { amount: '75.00', currency: 'BRL' }, walletVersion: 2, idempotentReplay: true });
      if (state === Status.Rejected) expect(result).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS' });
    }
  });
  test('conflicts, transient database failure and programming errors are distinct and sanitized', async () => {
    for (const [error, expected, code] of [
      [new IdempotencyConflictError('secret-key'), 409, 'IDEMPOTENCY_CONFLICT'],
      [new ExternalTransactionConflictError('provider', 'external'), 409, 'EXTERNAL_TRANSACTION_CONFLICT'],
      [Object.assign(new Error('insert secret SQL'), { code: '23505', constraint: 'wallets_player_currency_unique' }), 409, 'WALLET_ALREADY_EXISTS'],
      [Object.assign(new Error('secret password'), { code: 'ECONNREFUSED' }), 503, 'DEPENDENCY_UNAVAILABLE'],
      [new AggregateError([Object.assign(new Error('nested secret'), { code: 'ECONNREFUSED' })], 'pool failed'), 503, 'DEPENDENCY_UNAVAILABLE'],
      [new Error('connect ECONNREFUSED postgres:5432'), 503, 'DEPENDENCY_UNAVAILABLE'],
      [new Error('Connection terminated unexpectedly'), 503, 'DEPENDENCY_UNAVAILABLE'],
      [new Error('secret stack'), 500, 'INTERNAL_ERROR'],
    ] as const) {
      failure = error;
      const response = await submit(body, 'key'); expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({ statusCode: expected, code });
    }
    failure = undefined;
  });
  test('query not-found responses and malformed cursor are mapped before persistence', async () => {
    for (const path of ['/wallets/missing', '/wallets/missing/ledger', '/wagering/transactions/missing', '/providers/p/wagering/transactions/missing']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/wallets/missing/ledger?cursor=garbage`)).status).toBe(400);
  });
  test('wallet input uses Money; externally supplied OPENING is rejected at both parsers', () => {
    expect(parseWallet({ playerId: 'player', initialBalance: { amount: '0.00', currency: 'BRL' } }).initialBalance.isZero()).toBe(true);
    expect(() => parseWallet({ playerId: 'player', initialBalance: 100 })).toThrow();
    expect(() => parseWager({ ...body, kind: 'OPENING' })).toThrow();
  });
  test('opaque cursor preserves microseconds, is wallet-bound, versioned and rejects malformed dates', () => {
    const position = { walletId: 'wallet', id: 'ledger-1', createdAt: '2026-09-06T12:00:00.123456Z' };
    const cursor = encodeCursor(position);
    expect(parseLedgerQuery({ cursor, limit: '7' }, 'wallet')).toEqual({ limit: 7, after: position });
    expect(parseLedgerQuery({}, 'wallet')).toEqual({ limit: 50 });
    const invalid = [ { ...position, v: 2 }, { ...position, v: 1, createdAt: '2026-02-30T12:00:00.123456Z' },
      { ...position, v: 1, id: [] }, { ...position, v: 1, walletId: 'another-wallet' } ];
    for (const value of invalid) expect(() => parseLedgerQuery({ cursor: Buffer.from(JSON.stringify(value)).toString('base64url') }, 'wallet')).toThrow();
    for (const value of [{ limit: 50 }, { limit: '0' }, { limit: '101' }, { limit: ['1', '2'] }, { cursor: [] }, { offset: '1' }]) {
      expect(() => parseLedgerQuery(value, 'wallet')).toThrow();
    }
  });
});
