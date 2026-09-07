import { BadRequestException } from '@nestjs/common';
import { Money } from '../shared/domain/value-objects/money.js';
import { WagerTransactionKind } from '../wagering/domain/wager-transaction-kind.js';
import type { WagerBusinessPayload } from '../wagering/application/wager-business-payload.js';
import type { CreateWalletInput } from '../wallet/application/create-wallet.use-case.js';
import type { LedgerPosition } from './financial-query.port.js';

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Expected an object');
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BadRequestException('Unknown field');
  }
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 512) {
    throw new BadRequestException('Invalid identifier');
  }
  return value;
}
function money(value: unknown): Money {
  const props = record(value, ['amount', 'currency']);
  if (typeof props.amount !== 'string' || typeof props.currency !== 'string') {
    throw new BadRequestException('Money requires decimal string amount and currency');
  }
  try { return Money.from({ amount: props.amount, currency: props.currency }); }
  catch { throw new BadRequestException('Invalid money'); }
}
export function parseWallet(value: unknown): CreateWalletInput {
  const input = record(value, ['playerId', 'initialBalance']);
  return { playerId: identifier(input.playerId), initialBalance: money(input.initialBalance) };
}
export function parseWager(value: unknown): WagerBusinessPayload {
  const input = record(value, ['providerId', 'externalTransactionId', 'walletId', 'playerId',
    'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId']);
  const kind = input.kind;
  if (kind !== WagerTransactionKind.Bet && kind !== WagerTransactionKind.Win &&
      kind !== WagerTransactionKind.Loss && kind !== WagerTransactionKind.Refund &&
      kind !== WagerTransactionKind.Rollback) throw new BadRequestException('Invalid external kind');
  const reference = input.referenceExternalTransactionId === undefined
    ? undefined : identifier(input.referenceExternalTransactionId);
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    throw new BadRequestException('Reference required');
  }
  return {
    providerId: identifier(input.providerId), externalTransactionId: identifier(input.externalTransactionId),
    walletId: identifier(input.walletId), playerId: identifier(input.playerId),
    roundId: identifier(input.roundId), gameId: identifier(input.gameId), kind, money: money(input.money),
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  };
}
export function encodeCursor(position: LedgerPosition): string {
  return Buffer.from(JSON.stringify({ v: 1, walletId: position.walletId,
    createdAt: position.createdAt, id: position.id })).toString('base64url');
}
export function parseLedgerQuery(value: unknown, walletId: string): { limit: number; after?: LedgerPosition } {
  const query = record(value, ['limit', 'cursor']);
  const limit = query.limit === undefined ? 50 :
    typeof query.limit === 'string' && /^[1-9]\d{0,2}$/.test(query.limit) ? Number(query.limit) : 0;
  if (limit < 1 || limit > 100) throw new BadRequestException('limit must be 1..100');
  if (query.cursor === undefined) return { limit };
  try {
    if (typeof query.cursor !== 'string' || query.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
    const position = record(decoded, ['v', 'walletId', 'createdAt', 'id']);
    if (position.v !== 1 || position.walletId !== walletId || typeof position.createdAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(position.createdAt) ||
        !Number.isFinite(Date.parse(position.createdAt)) ||
        new Date(position.createdAt).toISOString().slice(0, 19) !== position.createdAt.slice(0, 19)) throw new Error();
    const after = { walletId, createdAt: position.createdAt, id: identifier(position.id) };
    if (encodeCursor(after) !== query.cursor) throw new Error();
    return { limit, after };
  } catch { throw new BadRequestException('Invalid ledger cursor'); }
}
