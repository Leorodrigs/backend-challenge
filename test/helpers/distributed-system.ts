import { expect } from 'bun:test';
import { Pool } from 'pg';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { command, compose, dockerExecutable, endpoints, eventually } from '../../scripts/docker.js';
import type { LedgerView } from '../../src/api/financial-query.port.js';

export interface Reply {
  id: string; playerId: string; currency: string; balance: { amount: string; currency: string };
  version: number; transactionId: string; walletVersion: number; idempotentReplay: boolean;
  status: string; code: string; failureCode: string; items: LedgerView[]; nextCursor?: string;
  consistent: boolean; [key: string]: unknown;
}
export interface WagerBody {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: string; money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}
export class DistributedSystem {
  readonly project = process.env.DISTRIBUTED_PROJECT!;
  urls: string[] = JSON.parse(process.env.DISTRIBUTED_URLS ?? '[]') as string[];
  readonly pool = new Pool({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT),
    database: process.env.DATABASE_NAME, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 2000, statement_timeout: 15000, max: 20 });
  readonly sqs = new SQSClient({ endpoint: process.env.AWS_ENDPOINT_URL!, region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, useQueueUrlAsEndpoint: false, maxAttempts: 1 });
  readonly source = process.env.WAGER_QUEUE_URL!;
  readonly auditUrl = `${process.env.AWS_ENDPOINT_URL}/queue/us-east-1/000000000000/wager-integration-events-audit`;
  readonly audit = new Map<string, string[]>();
  readonly evidence: object[] = [];
  private roundRobin = 0;
  private readonly containers: string[] = [];

  constructor() { this.pool.on('error', () => {}); }
  async request(path: string, method = 'GET', body?: unknown, key?: string, instance?: number): Promise<{ status: number; body: Reply }> {
    const url = this.urls[instance ?? this.roundRobin++ % 3];
    if (!url) throw new Error('Missing application URL');
    const response = await fetch(`${url}${path}`, { method,
      headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const decoded: unknown = await response.json();
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid JSON response');
    return { status: response.status, body: decoded as Reply };
  }
  async wallet(amount = '100.00', playerId = randomUUID()): Promise<Reply> {
    const response = await this.request('/wallets', 'POST', { playerId, initialBalance: { amount, currency: 'BRL' } });
    expect(response.status).toBe(201); return response.body;
  }
  wager(wallet: Reply, kind = 'BET', amount = '25.00', reference?: string): WagerBody {
    return { providerId: 'provider-final', externalTransactionId: randomUUID(), playerId: wallet.playerId,
      walletId: wallet.id, roundId: wallet.id, gameId: 'game-final', kind, money: { amount, currency: 'BRL' },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }) };
  }
  submit(body: WagerBody, key = randomUUID(), instance?: number) {
    return this.request('/wagering/transactions', 'POST', body, key, instance);
  }
  async count(sql: string, parameters: unknown[] = []): Promise<number> {
    const result = await this.pool.query<{ count: string }>(sql, parameters);
    return Number(result.rows[0]?.count ?? '0');
  }
  async state(walletId: string, amount: string, version: number) {
    const result = await this.pool.query('select balance_amount::text,version from wallets where id=$1', [walletId]);
    expect(result.rows).toEqual([{ balance_amount: amount, version }]);
    expect((await this.request(`/wallets/${walletId}/reconciliation`, 'POST')).body.consistent).toBe(true);
  }
  envelope(body: WagerBody, key = randomUUID(), messageId = randomUUID()) {
    return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...body, idempotencyKey: key } };
  }
  async send(envelope: object, group = randomUUID()) {
    // Fresh FIFO dedup IDs force logical duplicates through application Inbox/idempotency.
    return this.sqs.send(new SendMessageCommand({ QueueUrl: this.source, MessageBody: JSON.stringify(envelope),
      MessageDeduplicationId: randomUUID(), MessageGroupId: group }));
  }
  async queueSize(url = this.source): Promise<number> {
    const result = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    return Number(result.Attributes?.ApproximateNumberOfMessages ?? '0') + Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
  }
  async drainAudit() {
    for (;;) {
      const response = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.auditUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      if (!response.Messages?.length) return;
      for (const message of response.Messages) {
        const body: unknown = JSON.parse(message.Body!);
        if (body === null || typeof body !== 'object' || !('eventId' in body) || typeof body.eventId !== 'string') throw new Error('Invalid audit event');
        const deliveries = this.audit.get(body.eventId) ?? [];
        deliveries.push(message.Body!); this.audit.set(body.eventId, deliveries);
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.auditUrl, ReceiptHandle: message.ReceiptHandle! }));
      }
    }
  }
  async waitForAuditEvent(eventId: string, minimumDeliveries = 1, timeoutMs = 60000) {
    return eventually(async () => {
      await this.drainAudit();
      return this.audit.get(eventId)?.length ?? 0;
    }, (deliveries) => deliveries >= minimumDeliveries, timeoutMs);
  }
  async drain() {
    await eventually(() => this.queueSize(), (count) => count === 0);
    await eventually(() => this.count('select count(*) from outbox_messages where published_at is null'), (count) => count === 0);
    await eventually(async () => {
      await this.drainAudit();
      const events = await this.pool.query<{ id: string }>('select id from outbox_messages');
      return events.rows.filter(({ id }) => (this.audit.get(id)?.length ?? 0) < 1).map(({ id }) => id);
    }, (missing) => missing.length === 0, 60000);
  }
  async stopApps() { await compose(this.project, ['stop', '-t', '12', 'app-a', 'app-b', 'app-c'], true); }
  async startApps() {
    await compose(this.project, ['start', 'app-a', 'app-b', 'app-c'], true);
    this.urls = await endpoints(this.project);
    await Promise.all(this.urls.map((url) => eventually(() => fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status), (s) => s === 200)));
  }
  async startApp(index: 0 | 1 | 2) {
    const service = `app-${String.fromCharCode('a'.charCodeAt(0) + index)}`;
    await compose(this.project, ['start', service], true);
    this.urls[index] = `http://${await compose(this.project, ['port', service, '3000'], true)}`;
    await eventually(
      () => fetch(`${this.urls[index]}/health/ready`, { signal: AbortSignal.timeout(5000) }).then((response) => response.status),
      (status) => status === 200,
    );
  }
  async waitServiceHealthy(service: string, timeoutMs = 60000) {
    const container = await compose(this.project, ['ps', '-q', service], true);
    if (!container) throw new Error(`Missing service container: ${service}`);
    await eventually(
      () => command([...dockerExecutable, 'inspect', '--format', '{{.State.Health.Status}}', container], { quiet: true }),
      (status) => status === 'healthy',
      timeoutMs,
    );
  }
  async fixture(mode: string, ...args: string[]) {
    const name = `${this.project}-fault-${randomUUID().slice(0, 8)}`;
    await compose(this.project, ['run', '-d', '--no-deps', '--name', name, 'fixture', 'bun', 'test/fixtures/crash-worker.ts', mode, ...args], true);
    this.containers.push(name); return name;
  }
  async fixtureBarrier(name: string): Promise<Record<string, unknown>> {
    const content = await eventually(async () => {
      const logs = await command([...dockerExecutable, 'logs', name], { quiet: true });
      return logs.split('\n').find((line) => line.startsWith('FIXTURE_BARRIER '));
    }, (line) => line !== undefined);
    return JSON.parse(content!.slice('FIXTURE_BARRIER '.length)) as Record<string, unknown>;
  }
  async kill(name: string, signal = 'KILL') {
    await command([...dockerExecutable, 'kill', '--signal', signal, name], { quiet: true });
    if (signal === 'KILL') await this.exited(name);
  }
  async exited(name: string) {
    const state = await eventually(() => command([...dockerExecutable, 'inspect', '--format', '{{json .State}}', name], { quiet: true }),
      (value) => (JSON.parse(value) as { Running: boolean }).Running === false);
    this.evidence.push({ container: name, state: JSON.parse(state) as unknown });
  }
  async invariants() {
    await this.drain();
    const checks: Record<string, string> = {
      wallet_ledger_sum: `select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id=w.id group by w.id
        having w.balance_amount <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)`,
      money_and_currency: `select id from wallets where balance_amount < 0 or balance_amount='NaN'::numeric or currency !~ '^[A-Z]{3}$'
        union all select l.id from wallet_ledger_entries l join wallets w on w.id=l.wallet_id where l.currency<>w.currency or l.amount<0 or l.balance_before<0 or l.balance_after<0`,
      ledger_arithmetic: `select id from wallet_ledger_entries where balance_after <> balance_before + case direction when 'CREDIT' then amount else -amount end`,
      ledger_transaction: `select l.id from wallet_ledger_entries l left join wager_transactions t on t.id=l.transaction_id
        where t.id is null or t.wallet_id<>l.wallet_id or t.status<>'PROCESSED' or t.kind='LOSS' or t.amount=0 or t.amount<>l.amount or t.currency<>l.currency`,
      ledger_cardinality: `select t.id from wager_transactions t left join wallet_ledger_entries l on l.transaction_id=t.id and l.wallet_id=t.wallet_id group by t.id
        having count(l.id) <> case when t.status='PROCESSED' and t.kind<>'LOSS' and t.amount>0 then 1 else 0 end`,
      wallet_version: `select w.id from wallets w left join wager_transactions t on t.wallet_id=w.id left join wallet_ledger_entries l on l.transaction_id=t.id
        group by w.id having w.version <> 1 + count(l.id) filter(where t.kind<>'OPENING')`,
      ledger_continuity: `select id from (select l.id, l.balance_before, lag(l.balance_after,1,0::numeric) over(partition by l.wallet_id order by t.result_wallet_version) as previous_balance,
        t.result_balance_amount, l.balance_after from wallet_ledger_entries l join wager_transactions t on t.id=l.transaction_id) chain
        where balance_before<>previous_balance or result_balance_amount<>balance_after`,
      snapshot_nonnegative: `select id from wager_transactions where result_balance_amount<0 or result_balance_amount='NaN'::numeric or result_wallet_version<1`,
      duplicate_reversal: `select reference_transaction_id from wager_transactions where status='PROCESSED' and kind in ('REFUND','ROLLBACK') group by reference_transaction_id,kind having count(*)>1`,
      incomplete_inbox: `select message_id from inbox_messages where processed_at is null`,
      incomplete_work: `select id from wager_transactions where status in ('PENDING','PENDING_REFERENCE') union all select id from outbox_messages where published_at is null`,
    };
    for (const [name, sql] of Object.entries(checks)) {
      const violations = (await this.pool.query(sql)).rows;
      expect(violations, name).toEqual([]);
    }
    const events = await this.pool.query<{ id: string; payload: object }>('select id,payload from outbox_messages');
    for (const row of events.rows) {
      const deliveries = this.audit.get(row.id);
      expect(deliveries?.length, `missing event ${row.id}`).toBeGreaterThanOrEqual(1);
      for (const delivery of deliveries!) expect(JSON.parse(delivery)).toEqual(row.payload);
    }
    const wallets = await this.pool.query<{ id: string }>('select id from wallets');
    for (const wallet of wallets.rows) expect((await this.request(`/wallets/${wallet.id}/reconciliation`, 'POST')).body.consistent).toBe(true);
    expect(await this.queueSize(process.env.WAGER_DLQ_URL!)).toBe(0);
    this.evidence.push({ invariantChecks: Object.keys(checks), wallets: wallets.rowCount, events: events.rowCount,
      ledgerEntries: await this.count('select count(*) from wallet_ledger_entries'),
      transactions: await this.count('select count(*) from wager_transactions'), inbox: await this.count('select count(*) from inbox_messages'),
      auditDeliveries: [...this.audit.values()].reduce((sum, list) => sum + list.length, 0) });
  }
  async close() {
    await Bun.write(`test-results/${this.project}-evidence.json`, JSON.stringify(this.evidence, null, 2));
    for (const name of this.containers) await command([...dockerExecutable, 'rm', '-f', name], { quiet: true, allowFailure: true });
    await this.pool.end(); this.sqs.destroy();
  }
}
