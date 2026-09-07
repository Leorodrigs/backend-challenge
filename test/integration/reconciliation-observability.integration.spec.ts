import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { MikroORM } from '@mikro-orm/core';

import {
  applicationConfiguration,
  parseEnvironment,
  type ApplicationConfiguration,
} from '../../src/config/application.config.js';
import { HealthController } from '../../src/health/health.controller.js';
import { LivenessHealthIndicator } from '../../src/health/liveness.health-indicator.js';
import { PostgresHealthIndicator } from '../../src/health/postgres.health-indicator.js';
import { SqsHealthIndicator } from '../../src/health/sqs.health-indicator.js';
import { SQS_CLIENT } from '../../src/messaging/aws/aws.constants.js';
import { ApplicationMetrics } from '../../src/observability/application-metrics.js';
import { MetricsCollector } from '../../src/observability/metrics.collector.js';
import { MetricsController } from '../../src/observability/metrics.controller.js';
import { MikroOrmMetricsStatePersistence } from '../../src/persistence/mikro-orm/mikro-orm-metrics-state.persistence.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { MikroOrmWalletReconciliationPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wallet-reconciliation.persistence.js';
import { Money } from '../../src/shared/domain/value-objects/money.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind.js';
import { ReconcileWalletUseCase } from '../../src/wallet/reconciliation/reconcile-wallet.use-case.js';
import { ReconciliationController } from '../../src/wallet/reconciliation/reconciliation.controller.js';
import { LedgerCurrencyIntegrityError } from '../../src/wallet/reconciliation/wallet-reconciliation.errors.js';
import {
  createDisposableSqsQueues,
  createSqsClient,
  type DisposableSqsQueues,
} from '../helpers/sqs-test-queues.js';
import {
  createWagerProcessingDatabase,
  type WagerProcessingDatabase,
} from '../helpers/wager-processing-database.js';
import {
  money,
  seedWallet,
  wagerInput,
} from '../helpers/wager-processing-fixtures.js';

const shouldRun = process.env.RUN_INTEGRATION_TESTS === 'true';

interface TableCounts {
  wallets: string;
  ledger: string;
  wagers: string;
  inbox: string;
  outbox: string;
}

describe.skipIf(!shouldRun)('reconciliation and observability HTTP', () => {
  let database: WagerProcessingDatabase;
  let sqs: SQSClient;
  let queues: DisposableSqsQueues;
  let configuration: ApplicationConfiguration;
  let metrics: ApplicationMetrics;
  let reconciliation: ReconcileWalletUseCase;
  let collector: MetricsCollector;
  let processing: ProcessWagerTransactionUseCase;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    database = await createWagerProcessingDatabase();
    const baseConfiguration = parseEnvironment(process.env);
    sqs = createSqsClient(baseConfiguration);
    queues = await createDisposableSqsQueues(sqs);
    configuration = {
      ...baseConfiguration,
      aws: {
        ...baseConfiguration.aws,
        wagerQueueUrl: queues.sourceUrl,
        wagerDlqUrl: queues.dlqUrl,
        sqsConsumerEnabled: false,
      },
      workers: {
        ...baseConfiguration.workers,
        outboxPublisherEnabled: false,
      },
    };
    metrics = new ApplicationMetrics();
    reconciliation = new ReconcileWalletUseCase(
      new MikroOrmWalletReconciliationPersistence(database.orm.em),
      metrics,
      { log: mock(() => {}), warn: mock(() => {}) },
    );
    collector = new MetricsCollector(
      new MikroOrmMetricsStatePersistence(database.orm.em),
      sqs,
      configuration,
      metrics,
    );
    processing = new ProcessWagerTransactionUseCase(
      new MikroOrmWagerProcessingPersistence(database.orm.em),
      undefined,
      metrics,
      { log: mock(() => {}) },
    );

    class HttpTestModule {}
    Module({
      imports: [TerminusModule],
      controllers: [
        ReconciliationController,
        MetricsController,
        HealthController,
      ],
      providers: [
        { provide: ReconcileWalletUseCase, useValue: reconciliation },
        { provide: ApplicationMetrics, useValue: metrics },
        { provide: MetricsCollector, useValue: collector },
        { provide: MikroORM, useValue: database.orm },
        { provide: SQS_CLIENT, useValue: sqs },
        { provide: applicationConfiguration.KEY, useValue: configuration },
        LivenessHealthIndicator,
        PostgresHealthIndicator,
        SqsHealthIndicator,
      ],
    })(HttpTestModule);
    app = await NestFactory.create(HttpTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as {
      port: number;
    };
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    await queues?.close();
    sqs?.destroy();
    await database?.close();
  }, 20_000);

  async function tableCounts(): Promise<TableCounts> {
    const result = await database.pool.query<TableCounts>(
      `select
        (select count(*)::text from wallets) as wallets,
        (select count(*)::text from wallet_ledger_entries) as ledger,
        (select count(*)::text from wager_transactions) as wagers,
        (select count(*)::text from inbox_messages) as inbox,
        (select count(*)::text from outbox_messages) as outbox`,
    );
    const counts = result.rows[0];
    if (counts === undefined) throw new Error('PostgreSQL omitted table counts');
    return counts;
  }

  test('reconstructs OPENING, BET, WIN and REFUND while ignoring LOSS', async () => {
    const wallet = await seedWallet(database, '100.00');
    const bet = wagerInput(wallet, Kind.Bet, '25.00');
    await processing.execute(bet);
    await processing.execute(wagerInput(wallet, Kind.Win, '10.00'));
    await processing.execute(wagerInput(wallet, Kind.Loss, '8.00'));
    await processing.execute(
      wagerInput(wallet, Kind.Refund, '25.00', {
        roundId: bet.payload.roundId,
        referenceExternalTransactionId:
          bet.payload.externalTransactionId,
      }),
    );

    const result = await reconciliation.execute(wallet.id);

    expect(result.storedBalance.toJSON().amount).toBe('110.00');
    expect(result.calculatedBalance.toJSON().amount).toBe('110.00');
    expect(result.difference.toJSON().amount).toBe('0.00');
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(4);
  });

  test('diagnoses deliberate corruption without repairing any table', async () => {
    const wallet = await seedWallet(database, '100.00');
    await processing.execute(wagerInput(wallet, Kind.Bet, '25.00'));
    const before = await tableCounts();
    const ledgerBefore = await database.pool.query(
      `select * from wallet_ledger_entries
        where wallet_id = $1 order by created_at, id`,
      [wallet.id],
    );
    await database.pool.query(
      'update wallets set balance_amount = $2 where id = $1',
      [wallet.id, '101.25'],
    );

    const result = await reconciliation.execute(wallet.id);

    expect(result.storedBalance.toJSON().amount).toBe('101.25');
    expect(result.calculatedBalance.toJSON().amount).toBe('75.00');
    expect(result.difference.toJSON().amount).toBe('26.25');
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(2);
    expect(await tableCounts()).toEqual(before);
    const walletAfter = await database.pool.query<{ balance: string }>(
      'select balance_amount::text as balance from wallets where id = $1',
      [wallet.id],
    );
    expect(walletAfter.rows[0]?.balance).toBe('101.25');
    const ledgerAfter = await database.pool.query(
      `select * from wallet_ledger_entries
        where wallet_id = $1 order by created_at, id`,
      [wallet.id],
    );
    expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);

    await database.pool.query(
      'update wallets set balance_amount = $2 where id = $1',
      [wallet.id, '74.00'],
    );
    expect(
      (await reconciliation.execute(wallet.id)).difference.toJSON().amount,
    ).toBe('-1.00');
  });

  test('keeps NUMERIC(20,2) precision without IEEE-754 conversion', async () => {
    const wallet = await seedWallet(database, '999999999999999999.99');

    const result = await reconciliation.execute(wallet.id);

    expect(result.storedBalance.toJSON().amount).toBe(
      '999999999999999999.99',
    );
    expect(result.calculatedBalance.toJSON().amount).toBe(
      '999999999999999999.99',
    );
    expect(result.difference.toJSON().amount).toBe('0.00');
    expect(result.checkedEntries).toBe(1);
  });

  test('handles a valid zero wallet and explicitly rejects mixed ledger currency', async () => {
    const zeroWallet = await seedWallet(database, '0.00');
    const zero = await reconciliation.execute(zeroWallet.id);
    expect(zero.calculatedBalance.toJSON().amount).toBe('0.00');
    expect(zero.checkedEntries).toBe(0);

    const transactionId = randomUUID();
    await database.pool.query(
      `insert into wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        created_at, status, processed_at, result_balance_amount,
        result_balance_currency, result_wallet_version
      ) values ($1, 'provider', $2, $3, $4, $5, $6, 'round', 'game',
        'WIN', '1.00', 'USD', now(), 'PROCESSED', now(), '0.00', 'BRL', 1)`,
      [
        transactionId,
        `external-${transactionId}`,
        `key-${transactionId}`,
        'a'.repeat(64),
        zeroWallet.id,
        zeroWallet.playerId,
      ],
    );
    await database.pool.query(
      `insert into wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at
      ) values ($1, $2, $3, 'CREDIT', '1.00', 'USD', '0.00', '1.00', now())`,
      [randomUUID(), zeroWallet.id, transactionId],
    );

    await expect(reconciliation.execute(zeroWallet.id)).rejects.toBeInstanceOf(
      LedgerCurrencyIntegrityError,
    );
  });

  test('serves reconciliation, metrics and health over real HTTP', async () => {
    const wallet = await seedWallet(database, '50.00');
    await processing.execute(wagerInput(wallet, Kind.Bet, '10.00'));
    await processing.execute(wagerInput(wallet, Kind.Bet, '100.00'));
    const missingReference = wagerInput(wallet, Kind.Refund, '10.00', {
      referenceExternalTransactionId: `missing-${randomUUID()}`,
    });
    await processing.execute(missingReference);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.dlqUrl,
        MessageBody: '{}',
        MessageGroupId: 'metrics',
        MessageDeduplicationId: randomUUID(),
      }),
    );
    const before = await tableCounts();

    const reconciliationResponse = await fetch(
      `${baseUrl}/wallets/${wallet.id}/reconciliation`,
      { method: 'POST' },
    );
    expect(reconciliationResponse.status).toBe(200);
    expect(await reconciliationResponse.json()).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '40.00', currency: 'BRL' },
      calculatedBalance: { amount: '40.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    expect(await tableCounts()).toEqual(before);

    const missing = await fetch(
      `${baseUrl}/wallets/missing-wallet/reconciliation`,
      { method: 'POST' },
    );
    expect(missing.status).toBe(404);

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get('content-type')).toContain(
      'text/plain',
    );
    const body = await metricsResponse.text();
    expect(body).toContain('wager_transactions_current{status="PROCESSED"}');
    expect(body).toContain('wager_transactions_current{status="REJECTED"}');
    expect(body).toContain(
      'wager_transactions_current{status="PENDING_REFERENCE"}',
    );
    expect(body).toMatch(/wager_outbox_pending_messages [1-9]\d*/);
    expect(body).toMatch(/wager_outbox_lag_seconds \d/);
    expect(body).toContain('wager_dlq_messages_visible 1');
    expect(body).toContain('wager_reconciliation_total{result="consistent"}');

    await database.pool.query(
      `update outbox_messages
          set published_at = now(), next_attempt_at = null
        where published_at is null`,
    );
    const settledMetricsResponse = await fetch(`${baseUrl}/metrics`);
    expect(settledMetricsResponse.status).toBe(200);
    const settledBody = await settledMetricsResponse.text();
    expect(settledBody).toContain('wager_outbox_pending_messages 0');
    expect(settledBody).toContain('wager_outbox_lag_seconds 0');

    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
  }, 20_000);
});
