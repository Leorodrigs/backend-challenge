import { EntityManager, IsolationLevel } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';

import { Money } from '../../shared/domain/value-objects/money.js';
import { LedgerCurrencyIntegrityError } from '../../wallet/reconciliation/wallet-reconciliation.errors.js';
import {
  WalletReconciliationPersistence,
  type WalletReconciliationSnapshot,
} from '../../wallet/reconciliation/wallet-reconciliation.persistence.js';

interface WalletBalanceRow {
  walletId: string;
  balanceAmount: string;
  currency: string;
}

interface LedgerAggregateRow {
  checkedEntries: string;
  mismatchedEntries: string;
  calculatedAmount: string;
}

@Injectable()
export class MikroOrmWalletReconciliationPersistence extends WalletReconciliationPersistence {
  constructor(
    @Inject(EntityManager)
    private readonly entityManager: PostgreSqlEntityManager,
  ) {
    super();
  }

  override readSnapshot(
    walletId: string,
  ): Promise<WalletReconciliationSnapshot | undefined> {
    const isolated = this.entityManager.fork({ clear: true, useContext: false });

    return isolated.transactional(
      async (transactionalEntityManager) => {
        await transactionalEntityManager.execute('set transaction read only');
        const wallets = await transactionalEntityManager.execute<
          WalletBalanceRow[]
        >(
          `select id as "walletId", balance_amount::text as "balanceAmount",
                  currency
             from wallets
            where id = ?`,
          [walletId],
        );
        const wallet = wallets[0];
        if (wallet === undefined) return undefined;

        const aggregates = await transactionalEntityManager.execute<
          LedgerAggregateRow[]
        >(
          `select count(*)::text as "checkedEntries",
                  count(*) filter (where currency <> ?)::text as "mismatchedEntries",
                  coalesce(sum(
                    case
                      when currency = ? and direction = 'CREDIT' then amount
                      when currency = ? and direction = 'DEBIT' then -amount
                      else 0::numeric
                    end
                  ), 0::numeric)::numeric(20,2)::text as "calculatedAmount"
             from wallet_ledger_entries
            where wallet_id = ?`,
          [wallet.currency, wallet.currency, wallet.currency, walletId],
        );
        const aggregate = aggregates[0];
        if (aggregate === undefined) {
          throw new Error('PostgreSQL omitted the reconciliation aggregate');
        }
        if (this.toSafeCount(aggregate.mismatchedEntries) !== 0) {
          throw new LedgerCurrencyIntegrityError(walletId, wallet.currency);
        }

        return {
          walletId: wallet.walletId,
          storedBalance: Money.from({
            amount: wallet.balanceAmount,
            currency: wallet.currency,
          }),
          calculatedBalance: Money.from({
            amount: aggregate.calculatedAmount,
            currency: wallet.currency,
          }),
          checkedEntries: this.toSafeCount(aggregate.checkedEntries),
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );
  }

  private toSafeCount(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new Error('PostgreSQL returned an invalid reconciliation count');
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count)) {
      throw new Error('Reconciliation count exceeds JavaScript safe integer range');
    }
    return count;
  }
}
