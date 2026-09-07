import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialQueryPort, type LedgerPage, type LedgerPosition, type TransactionView, type WalletView } from '../../api/financial-query.port.js';
import { encodeCursor } from '../../api/transport-validation.js';

interface WalletRow { id: string; player_id: string; currency: string; balance_amount: string; version: number; created_at: string; updated_at: string }
interface TransactionRow {
  id: string; provider_id: string; external_transaction_id: string; wallet_id: string;
  player_id: string; round_id: string; game_id: string; kind: string; amount: string;
  currency: string; status: string; reference_external_transaction_id: string | null;
  reference_transaction_id: string | null; failure_code: string | null; created_at: string; processed_at: string | null;
}
interface LedgerRow { id: string; wallet_id: string; transaction_id: string; direction: string;
  amount: string; currency: string; balance_before: string; balance_after: string; timestamp: string }
const timestamp = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${column}`;
const transactionColumns = `id, provider_id, external_transaction_id, wallet_id, player_id, round_id,
  game_id, kind, amount::text, currency, status, reference_external_transaction_id,
  reference_transaction_id, failure_code, ${timestamp('created_at')}, ${timestamp('processed_at')}`;

@Injectable()
export class MikroOrmFinancialQueryAdapter extends FinancialQueryPort {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) { super(); }

  async wallet(id: string): Promise<WalletView | undefined> {
    const [row] = await this.orm.em.fork().getConnection().execute<WalletRow[]>(
      `select id, player_id, currency, balance_amount::text, version, ${timestamp('created_at')}, ${timestamp('updated_at')} from wallets where id = ?`, [id]);
    return row === undefined ? undefined : { id: row.id, playerId: row.player_id, currency: row.currency,
      balance: { amount: row.balance_amount, currency: row.currency }, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async transaction(id: string): Promise<TransactionView | undefined> {
    const [row] = await this.orm.em.fork().getConnection().execute<TransactionRow[]>(
      `select ${transactionColumns} from wager_transactions where id = ?`, [id]);
    return row === undefined ? undefined : this.transactionView(row);
  }
  async providerTransaction(providerId: string, externalId: string): Promise<TransactionView | undefined> {
    const [row] = await this.orm.em.fork().getConnection().execute<TransactionRow[]>(
      `select ${transactionColumns} from wager_transactions where provider_id = ? and external_transaction_id = ?`, [providerId, externalId]);
    return row === undefined ? undefined : this.transactionView(row);
  }
  async ledger(walletId: string, limit: number, after?: LedgerPosition): Promise<LedgerPage> {
    // Preserve PostgreSQL microseconds in the key; JS Date would truncate them.
    const rows = await this.orm.em.fork().getConnection().execute<LedgerRow[]>(`
      select id, wallet_id, transaction_id, direction, amount::text, currency,
        balance_before::text, balance_after::text,
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as timestamp
      from wallet_ledger_entries where wallet_id = ?
      ${after === undefined ? '' : 'and (created_at, id) > (?::timestamptz, ?)'}
      order by created_at, id limit ?`,
    [walletId, ...(after === undefined ? [] : [after.createdAt, after.id]), limit + 1]);
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return { items: selected.map((row) => ({ id: row.id, walletId: row.wallet_id, transactionId: row.transaction_id,
      direction: row.direction, money: { amount: row.amount, currency: row.currency },
      balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency }, createdAt: row.timestamp })),
      ...(rows.length > limit && last !== undefined ? { nextCursor: encodeCursor({ walletId, id: last.id, createdAt: last.timestamp }) } : {}),
    };
  }
  private transactionView(row: TransactionRow): TransactionView {
    return { id: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
      walletId: row.wallet_id, playerId: row.player_id, roundId: row.round_id, gameId: row.game_id,
      kind: row.kind, money: { amount: row.amount, currency: row.currency }, status: row.status,
      referenceExternalTransactionId: row.reference_external_transaction_id,
      referenceTransactionId: row.reference_transaction_id, failureCode: row.failure_code,
      createdAt: row.created_at, processedAt: row.processed_at };
  }
}
