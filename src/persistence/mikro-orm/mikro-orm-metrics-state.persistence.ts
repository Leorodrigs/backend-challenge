import { EntityManager } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';

import {
  WAGER_TRANSACTION_STATUSES,
  type WagerTransactionMetricStatus,
} from '../../observability/application-metrics.js';
import {
  MetricsStatePersistence,
  type PersistedMetricsState,
} from '../../observability/metrics-state.persistence.js';

interface StatusCountRow {
  status: string;
  count: string;
}

interface CountRow {
  count: string;
}

interface OutboxStateRow {
  pendingMessages: string;
  lagSeconds: string;
}

@Injectable()
export class MikroOrmMetricsStatePersistence extends MetricsStatePersistence {
  constructor(
    @Inject(EntityManager)
    private readonly entityManager: PostgreSqlEntityManager,
  ) {
    super();
  }

  override async collect(): Promise<PersistedMetricsState> {
    const entityManager = this.entityManager.fork({
      clear: true,
      useContext: false,
    });
    const statusRows = await entityManager.execute<StatusCountRow[]>(
      `select status, count(*)::text as count
         from wager_transactions
        group by status`,
    );
    const lockRows = await entityManager.execute<CountRow[]>(
      `select count(*)::text as count
         from pg_stat_activity
        where wait_event_type = 'Lock'
          and cardinality(pg_blocking_pids(pid)) > 0
          and query ~* 'wallets'
          and query ~* 'for[[:space:]]+update'`,
    );
    const outboxRows = await entityManager.execute<OutboxStateRow[]>(
      `select count(*)::text as "pendingMessages",
              coalesce(
                greatest(
                  extract(epoch from (clock_timestamp() - min(occurred_at))),
                  0
                ),
                0
              )::text as "lagSeconds"
         from outbox_messages
        where published_at is null`,
    );

    const transactionsByStatus: Partial<
      Record<WagerTransactionMetricStatus, number>
    > = {};
    for (const row of statusRows) {
      if (!this.isKnownStatus(row.status)) {
        throw new Error('PostgreSQL returned an unknown wager status');
      }
      transactionsByStatus[row.status] = this.safeInteger(row.count);
    }
    const outbox = outboxRows[0];
    if (outbox === undefined || lockRows[0] === undefined) {
      throw new Error('PostgreSQL omitted an observability aggregate');
    }
    const lagSeconds = Number(outbox.lagSeconds);
    if (!Number.isFinite(lagSeconds) || lagSeconds < 0) {
      throw new Error('PostgreSQL returned an invalid Outbox lag');
    }

    return {
      transactionsByStatus,
      walletLockWaiters: this.safeInteger(lockRows[0].count),
      outboxLagSeconds: lagSeconds,
      outboxPendingMessages: this.safeInteger(outbox.pendingMessages),
    };
  }

  private isKnownStatus(value: string): value is WagerTransactionMetricStatus {
    return (WAGER_TRANSACTION_STATUSES as readonly string[]).includes(value);
  }

  private safeInteger(value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new Error('PostgreSQL returned an invalid observability count');
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count)) {
      throw new Error('Observability count exceeds JavaScript safe integer range');
    }
    return count;
  }
}
