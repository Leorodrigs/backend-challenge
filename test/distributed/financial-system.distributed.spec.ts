import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DistributedSystem } from '../helpers/distributed-system.js';
import { command, compose, dockerExecutable, eventually } from '../../scripts/docker.js';

describe.skipIf(process.env.RUN_DISTRIBUTED_TESTS !== 'true')('three independent application processes with PostgreSQL and LocalStack', () => {
  let system: DistributedSystem;
  beforeAll(async () => {
    system = new DistributedSystem();
    expect(new Set(system.urls).size).toBe(3);
    const ids = await compose(system.project, ['ps', '-q', 'app-a', 'app-b', 'app-c'], true);
    expect(ids.split('\n').length).toBe(3);
    system.evidence.push({ appContainers: ids.split('\n'), urls: system.urls });
    await system.drainAudit();
  });
  afterAll(async () => { await system?.close(); });

  test.serial('HTTP contracts, zero opening, decimal validation, OPENING exclusion, lookups and historical rejections', async () => {
    const wallet = await system.wallet('0.00');
    await system.state(wallet.id, '0.00', 1);
    expect((await system.request(`/wallets/${wallet.id}/ledger`)).body.items).toEqual([]);
    for (const amount of [25, '25', '25.0', '25.000', '1e2', 'NaN', 'Infinity', '-1.00', '']) {
      expect((await system.request('/wallets', 'POST', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } })).status).toBe(400);
      expect((await system.request('/wagering/transactions', 'POST', { ...system.wager(wallet), money: { amount, currency: 'BRL' } }, randomUUID())).status).toBe(400);
    }
    const wager = system.wager(wallet);
    expect((await system.request('/wagering/transactions', 'POST', wager)).status).toBe(400);
    expect((await system.submit({ ...wager, kind: 'OPENING' })).status).toBe(400);
    expect((await system.request('/wagering/transactions', 'POST', { ...wager, idempotencyKey: 'body-key' }, 'header-key')).status).toBe(400);
    expect((await system.submit({ ...wager, kind: 'REFUND' })).status).toBe(400);
    expect((await system.request('/wallets/absent')).status).toBe(404);
    expect((await system.request('/wallets/absent/ledger')).status).toBe(404);
    expect((await system.request('/wagering/transactions/absent')).status).toBe(404);
    expect((await system.request('/providers/absent/wagering/transactions/absent')).status).toBe(404);
    expect((await system.submit({ ...wager, walletId: 'absent' })).status).toBe(404);
    expect((await system.submit({ ...wager, playerId: 'different' })).status).toBe(400);
    const key = randomUUID();
    const rejected = await system.submit(wager, key, 0);
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.body.balance.amount).toBe('0.00');
    expect((await system.submit(system.wager(wallet, 'WIN', '50.00'))).status).toBe(200);
    const replay = await system.submit(wager, key, 2);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
    const queried = (await system.request(`/wagering/transactions/${rejected.body.transactionId}`)).body;
    const external = (await system.request(`/providers/${wager.providerId}/wagering/transactions/${wager.externalTransactionId}`)).body;
    expect(external).toEqual(queried);
    for (const field of ['id', 'providerId', 'externalTransactionId', 'walletId', 'playerId', 'roundId', 'gameId', 'kind', 'money', 'status', 'referenceExternalTransactionId', 'referenceTransactionId', 'failureCode', 'createdAt', 'processedAt']) expect(field in queried).toBe(true);
    expect('payloadHash' in queried).toBe(false);
    expect('idempotencyKey' in queried).toBe(false);
    expect((await system.submit({ ...system.wager(wallet), money: { amount: '1.00', currency: 'USD' } })).body.failureCode).toBe('CURRENCY_MISMATCH');
    await system.state(wallet.id, '50.00', 2);
    for (const kind of ['BET', 'WIN', 'LOSS']) expect((await system.submit(system.wager(wallet, kind, '0.00'))).status).toBe(200);
    await system.state(wallet.id, '50.00', 2);
    const precise = await system.wallet('9007199254740993.37');
    expect((await system.submit(system.wager(precise, 'BET', '0.01'))).status).toBe(200);
    await system.state(precise.id, '9007199254740993.36', 2);
  });

  test.serial('10 concurrent wallet creations across A/B/C create one opening and nine conflicts', async () => {
    const playerId = randomUUID();
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => system.request('/wallets', 'POST', {
      playerId, initialBalance: { amount: '100.00', currency: 'BRL' },
    }, undefined, index % 3)));
    expect(responses.filter((r) => r.status === 201).length).toBe(1);
    expect(responses.filter((r) => r.status === 409).length).toBe(9);
    const wallet = responses.find((r) => r.status === 201)!.body;
    expect(await system.count('select count(*) from wager_transactions where wallet_id=$1 and kind=\'OPENING\'', [wallet.id])).toBe(1);
    expect(await system.count('select count(*) from wallet_ledger_entries where wallet_id=$1', [wallet.id])).toBe(1);
    await system.state(wallet.id, '100.00', 1);
    system.evidence.push({ scenario: 'wallet-creation-race', created: 1, conflicts: 9 });
  });

  test.serial('50 simultaneous identical BETs across A/B/C: one original, 49 replays, one debit, two events', async () => {
    const wallet = await system.wallet();
    const wager = system.wager(wallet); const key = randomUUID();
    const settled = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => system.submit(wager, key, index % 3)));
    expect(settled.filter((result) => result.status === 'fulfilled').length).toBe(50);
    const replies = settled.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(replies.filter((r) => !r.body.idempotentReplay).length).toBe(1);
    expect(replies.filter((r) => r.body.idempotentReplay).length).toBe(49);
    expect(new Set(replies.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await system.count('select count(*) from wallet_ledger_entries where transaction_id=$1', [replies[0]!.body.transactionId])).toBe(1);
    expect(await system.count('select count(*) from outbox_messages where payload->>\'correlationId\'=$1', [replies[0]!.body.transactionId])).toBe(2);
    await system.state(wallet.id, '75.00', 2);
    expect((await system.submit(system.wager(wallet, 'WIN', '5.00'), randomUUID(), 1)).status).toBe(200);
    for (const instance of [0, 1, 2]) {
      const replay = await system.submit(wager, key, instance);
      expect(replay.body.balance.amount).toBe('75.00'); expect(replay.body.walletVersion).toBe(2);
    }
    await system.state(wallet.id, '80.00', 3);
    system.evidence.push({ scenario: '50-bet-race', fulfilled: 50, originals: 1, replays: 49, debits: 1, balance: '75.00', version: 2, wagerEvents: 2 });
  });

  test.serial('20 hot-wallet races of 80 + 80 on 100 produce exactly one debit and one rejection', async () => {
    for (let batch = 0; batch < 4; batch++) await Promise.all(Array.from({ length: 5 }, async () => {
      const wallet = await system.wallet();
      const replies = await Promise.all([system.submit(system.wager(wallet, 'BET', '80.00')), system.submit(system.wager(wallet, 'BET', '80.00'))]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(replies.find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      await system.state(wallet.id, '20.00', 2);
    }));
    system.evidence.push({ scenario: 'hot-wallet', races: 20, processedPerRace: 1, rejectedPerRace: 1, balance: '20.00' });
  });

  test.serial('holding wallet A proves B/C/D commit before A lock is released', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => system.wallet()));
    const blocked = wallets[0]!;
    const lock = await system.pool.connect();
    await lock.query('begin'); await lock.query('select id from wallets where id=$1 for update', [blocked.id]);
    const pending = system.submit(system.wager(blocked));
    try {
      await eventually(() => system.count("select count(*) from pg_stat_activity where wait_event_type='Lock' and query ilike '%wallet%for update%'"), (n) => n > 0);
      const others = await Promise.all(wallets.slice(1).map((wallet) => system.submit(system.wager(wallet))));
      expect(others.every((r) => r.status === 200)).toBe(true);
      expect((await system.pool.query('select balance_amount::text from wallets where id=$1', [blocked.id])).rows[0]).toEqual({ balance_amount: '100.00' });
      for (const wallet of wallets.slice(1)) await system.state(wallet.id, '75.00', 2);
    } finally { await lock.query('rollback'); lock.release(); }
    expect((await pending).status).toBe(200);
  });

  test.serial('simultaneous divergent payload and provider/external keys give conflicts without extra effects', async () => {
    for (const mode of ['idempotency', 'external']) {
      const wallet = await system.wallet(); const wager = system.wager(wallet); const key = randomUUID();
      const replies = await Promise.all([system.submit(wager, key, 0), system.submit(
        { ...wager, money: { amount: mode === 'idempotency' ? '30.00' : '25.00', currency: 'BRL' } }, mode === 'idempotency' ? key : randomUUID(), 2)]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await system.count('select count(*) from wallet_ledger_entries where wallet_id=$1 and direction=\'DEBIT\'', [wallet.id])).toBe(1);
      expect(replies.find((r) => r.status === 409)?.body.code).toBe(mode === 'idempotency' ? 'IDEMPOTENCY_CONFLICT' : 'EXTERNAL_TRANSACTION_CONFLICT');
    }
  });

  test.serial('keyset pagination >100 rows and tied timestamps has no skips or duplicates; bad cursors/limits fail', async () => {
    const wallet = await system.wallet();
    // Fixture-only BEFORE INSERT trigger gives 105 entries the exact same microsecond.
    const tiedTimestamp = new Date().toISOString().replace('Z', '456Z');
    await system.pool.query(`create function final_test_ledger_timestamp() returns trigger language plpgsql as $$ begin
      if NEW.wallet_id = '${wallet.id}' then NEW.created_at = '${tiedTimestamp}'; end if; return NEW; end $$;
      create trigger final_test_timestamp before insert on wallet_ledger_entries for each row execute function final_test_ledger_timestamp();`);
    try {
      for (let batch = 0; batch < 7; batch++) {
        const replies = await Promise.all(Array.from({ length: 15 }, () => system.submit(system.wager(wallet, 'WIN', '1.00'))));
        expect(replies.every((r) => r.status === 200)).toBe(true);
      }
    } finally { await system.pool.query('drop trigger final_test_timestamp on wallet_ledger_entries; drop function final_test_ledger_timestamp();'); }
    expect((await system.request(`/wallets/${wallet.id}/ledger`)).body.items.length).toBe(50);
    const expected = (await system.pool.query<{ id: string }>('select id from wallet_ledger_entries where wallet_id=$1 order by created_at,id', [wallet.id])).rows.map((row) => row.id);
    const actual: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const page = await system.request(`/wallets/${wallet.id}/ledger?limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200); actual.push(...page.body.items.map((item) => item.id));
      cursor = page.body.nextCursor; pages++;
    } while (cursor !== undefined && pages < 100);
    expect(actual).toEqual(expected); expect(actual.length).toBe(106); expect(new Set(actual).size).toBe(106);
    for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=2&limit=3', 'cursor=garbage', 'cursor=', 'offset=1',
      `cursor=${Buffer.from(JSON.stringify({ v: 2, walletId: wallet.id, createdAt: '2026-09-06T00:00:00.000000Z', id: 'x' })).toString('base64url')}`]) {
      expect((await system.request(`/wallets/${wallet.id}/ledger?${query}`)).status).toBe(400);
    }
    await system.state(wallet.id, '205.00', 106);
    system.evidence.push({ scenario: 'keyset', rows: 106, tiedTimestamps: 105, pageSize: 7, pages });
  });

  test.serial('real SQS logical duplicates and different message IDs retain one business effect', async () => {
    const wallet = await system.wallet(); const body = system.wager(wallet); const envelope = system.envelope(body);
    await Promise.all([system.send(envelope), system.send(envelope)]);
    const secondMessageId = randomUUID();
    await system.send({ ...envelope, messageId: secondMessageId });
    await eventually(() => system.count('select count(*) from inbox_messages where processed_at is not null and message_id=$1', [envelope.messageId]), (n) => n === 1);
    await system.drain();
    await system.state(wallet.id, '75.00', 2);
    expect(await system.count('select count(*) from inbox_messages where message_id in ($1,$2) and processed_at is not null', [envelope.messageId, secondMessageId])).toBe(2);
    expect(await system.count('select count(*) from wager_transactions where wallet_id=$1 and kind=\'BET\'', [wallet.id])).toBe(1);
  });

  test.serial('all three SQS consumers process real messages from distinct FIFO groups', async () => {
    const wallet = await system.wallet(); await system.drain();
    const lock = await system.pool.connect();
    await lock.query('begin'); await lock.query('select id from wallets where id=$1 for update', [wallet.id]);
    const messages = Array.from({ length: 30 }, () => system.envelope(system.wager(wallet, 'WIN', '1.00')));
    try {
      await Promise.all(messages.map((message) => system.send(message)));
      // A consumer holds its current batch while blocked. SQS may return fewer
      // than ten, so prove participation by three independent container IPs.
      await eventually(() => system.count("select count(distinct client_addr) from pg_stat_activity where wait_event_type='Lock' and query ilike '%wallet%for update%'"), (n) => n >= 3);
    } finally { await lock.query('rollback'); lock.release(); }
    await system.drain(); await system.state(wallet.id, '130.00', 31);
    const consumed: Record<string, number> = {};
    for (const service of ['app-a', 'app-b', 'app-c']) {
      const logs = await compose(system.project, ['logs', '--no-color', service], true);
      const count = messages.filter((message) => logs.includes(message.messageId)).length;
      expect(count).toBeGreaterThan(0); consumed[service] = count;
    }
    system.evidence.push({ scenario: 'three-SQS-consumers', logicalMessages: 30, consumed });
  });

  test.serial('SQS refund before BET and rollback/refund/BET chain resolve with persisted pending replay', async () => {
    const wallet = await system.wallet(); const bet = system.wager(wallet); const refund = system.wager(wallet, 'REFUND', '25.00', bet.externalTransactionId);
    const rollback = system.wager(wallet, 'ROLLBACK', '25.00', refund.externalTransactionId);
    const refundEnvelope = system.envelope(refund);
    await system.send(system.envelope(rollback)); await system.send(refundEnvelope);
    await eventually(() => system.count('select count(*) from wager_transactions where wallet_id=$1 and status=\'PENDING_REFERENCE\'', [wallet.id]), (n) => n === 2);
    // Fixture scheduling barrier excludes worker retries during the replay check.
    await system.pool.query("update wager_transactions set reference_next_attempt_at=now()+interval '30 seconds' where external_transaction_id=$1", [refund.externalTransactionId]);
    const before = (await system.pool.query('select reference_attempt_count from wager_transactions where external_transaction_id=$1', [refund.externalTransactionId])).rows[0];
    const replay = await system.submit(refund, refundEnvelope.data.idempotencyKey);
    expect(replay.status).toBe(202); expect(replay.body.idempotentReplay).toBe(true);
    expect((await system.pool.query('select reference_attempt_count from wager_transactions where external_transaction_id=$1', [refund.externalTransactionId])).rows[0]).toEqual(before);
    await system.pool.query('update wager_transactions set reference_next_attempt_at=now() where external_transaction_id=$1', [refund.externalTransactionId]);
    await system.send(system.envelope(bet));
    await eventually(() => system.count('select count(*) from wager_transactions where wallet_id=$1 and status=\'PENDING_REFERENCE\'', [wallet.id]), (n) => n === 0);
    await system.state(wallet.id, '75.00', 4);
  });

  test.serial('two concurrent REFUNDs and two ROLLBACKs of one reference apply once per kind', async () => {
    for (const kind of ['REFUND', 'ROLLBACK']) {
      const wallet = await system.wallet(); const bet = system.wager(wallet); expect((await system.submit(bet)).status).toBe(200);
      const replies = await Promise.all([system.submit(system.wager(wallet, kind, '25.00', bet.externalTransactionId), randomUUID(), 0),
        system.submit(system.wager(wallet, kind, '25.00', bet.externalTransactionId), randomUUID(), 2)]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(replies.find((r) => r.status === 422)?.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      await system.state(wallet.id, '100.00', 3);
    }
  });

  test.serial('actual process death after financial commit before SQS DeleteMessage; another app deduplicates redelivery', async () => {
    const wallet = await system.wallet(); await system.drain(); await system.stopApps();
    const body = system.wager(wallet); const envelope = system.envelope(body);
    try {
      await system.send(envelope);
      const name = await system.fixture('commit-before-ack'); await system.fixtureBarrier(name);
      expect(await system.count('select count(*) from inbox_messages where message_id=$1 and processed_at is not null', [envelope.messageId])).toBe(1);
      const transaction = (await system.pool.query<{ id: string }>('select id from wager_transactions where external_transaction_id=$1', [body.externalTransactionId])).rows[0]!;
      expect(await system.count('select count(*) from wallet_ledger_entries where transaction_id=$1', [transaction.id])).toBe(1);
      expect(await system.count('select count(*) from outbox_messages where payload->>\'correlationId\'=$1', [transaction.id])).toBe(2);
      expect(await system.queueSize()).toBe(1);
      await system.kill(name);
      await system.startApps(); await system.drain();
      await system.state(wallet.id, '75.00', 2);
      expect(await system.count('select count(*) from inbox_messages where message_id=$1', [envelope.messageId])).toBe(1);
      expect(await system.count('select count(*) from wallet_ledger_entries where transaction_id=$1', [transaction.id])).toBe(1);
      system.evidence.push({ scenario: 'commit-before-ack', container: name, messageId: envelope.messageId, transactionId: transaction.id, inbox: 1, debit: 1, events: 2, sourceAfterRecovery: 0 });
    } finally { await system.startApps(); }
  });

  test.serial('actual death after commit before publish and after SNS success before mark preserves stable event identity', async () => {
    await system.drain(); await system.stopApps();
    const playerId = randomUUID();
    try {
      const committing = await system.fixture('commit-before-publish', playerId); const committed = await system.fixtureBarrier(committing);
      expect(await system.count('select count(*) from outbox_messages where published_at is null')).toBe(2);
      await system.kill(committing);
      const publishing = await system.fixture('publish-before-mark'); const published = await system.fixtureBarrier(publishing);
      const input = published.input as { Message: string };
      const event = JSON.parse(input.Message) as { eventId: string };
      await system.waitForAuditEvent(event.eventId);
      expect(system.audit.get(event.eventId)?.length).toBe(1);
      expect(await system.count('select count(*) from outbox_messages where id=$1 and published_at is null', [event.eventId])).toBe(1);
      await system.kill(publishing);
      await system.startApps(); await system.drain();
      expect(system.audit.get(event.eventId)?.length).toBeGreaterThanOrEqual(2);
      expect(new Set(system.audit.get(event.eventId)).size).toBe(1);
      expect((await system.request(`/wallets/${String(committed.walletId)}`)).body.balance.amount).toBe('100.00');
      system.evidence.push({ scenario: 'outbox-crash-windows', committing, publishing, eventId: event.eventId, deliveries: system.audit.get(event.eventId)?.length, stableEnvelope: true });
    } finally { await system.startApps(); }
  });

  test.serial('PostgreSQL outage: live stays up, ready fails, SQS remains unacknowledged, recovery applies once', async () => {
    const wallet = await system.wallet(); const wager = system.wager(wallet); const envelope = system.envelope(wager);
    await system.drain();
    await compose(system.project, ['stop', '-t', '2', 'postgres'], true);
    try {
      await system.send(envelope);
      expect((await system.request('/health/live')).status).toBe(200);
      expect((await system.request('/health/ready')).status).toBe(503);
      const httpFailure = await system.submit(system.wager(wallet));
      expect(httpFailure.status).toBe(503);
      expect(httpFailure.body.code).toBe('DEPENDENCY_UNAVAILABLE');
      await eventually(async () => compose(system.project, ['logs', '--since', '15s', 'app-a', 'app-b', 'app-c'], true),
        (logs) => logs.includes('retry_scheduled') || logs.includes('retry_visibility_failed'), 12000);
      expect(await system.queueSize()).toBe(1);
    } finally {
      await compose(system.project, ['start', 'postgres'], true);
      await eventually(
        () => system.pool.query('select 1').then(() => true),
        (ready) => ready,
        30000,
      );
    }
    await eventually(() => system.count('select count(*) from inbox_messages where message_id=$1 and processed_at is not null', [envelope.messageId]), (n) => n === 1);
    await system.startApps(); await system.drain(); await system.state(wallet.id, '75.00', 2);
  });

  test.serial('LocalStack network outage: HTTP commits with pending outbox, live/ready split, same queues recover', async () => {
    const wallet = await system.wallet(); await system.drain();
    // Pause retains LocalStack memory and volumes, so the fault cannot recreate empty queues.
    await compose(system.project, ['pause', 'localstack'], true);
    try {
      const result = await system.submit(system.wager(wallet)); expect(result.status).toBe(200);
      expect((await system.request('/health/live')).status).toBe(200);
      expect((await system.request('/health/ready')).status).toBe(503);
      expect(await system.count('select count(*) from outbox_messages where payload->>\'correlationId\'=$1 and published_at is null', [result.body.transactionId])).toBe(2);
      await eventually(() => system.count('select count(*) from outbox_messages where attempts>0 and published_at is null'), (n) => n > 0, 15000);
    } finally {
      await compose(system.project, ['unpause', 'localstack'], true);
      await system.waitServiceHealthy('localstack');
    }
    await system.drain(); await system.state(wallet.id, '75.00', 2);
    expect((await system.request('/health/ready')).status).toBe(200);
  });

  test.serial('SIGTERM while SQS financial work waits on a wallet drains safely and stops polling', async () => {
    const wallet = await system.wallet(); await system.drain(); await system.stopApps();
    await system.startApp(0);
    const lock = await system.pool.connect(); await lock.query('begin'); await lock.query('select id from wallets where id=$1 for update', [wallet.id]);
    let released = false;
    try {
      const envelope = system.envelope(system.wager(wallet)); await system.send(envelope);
      const name = await compose(system.project, ['ps', '-q', 'app-a'], true);
      await eventually(() => system.count("select count(*) from pg_stat_activity where wait_event_type='Lock' and query ilike '%wallet%for update%'"), (n) => n > 0);
      await system.kill(name, 'TERM');
      // The next delivery remains available while the production Nest process
      // drains its current batch. It must not poll another batch after TERM.
      const following = system.envelope(system.wager(wallet, 'WIN', '5.00'));
      await system.send(following);
      await lock.query('rollback'); released = true;
      await system.exited(name);
      const logs = await command([...dockerExecutable, 'logs', name], { quiet: true });
      expect(logs).toContain(envelope.messageId);
      expect(logs).toContain('acked');
      expect(logs).not.toContain(following.messageId);
      expect(await system.queueSize()).toBe(1);
      expect(await system.count('select count(*) from inbox_messages where message_id=$1 and processed_at is not null', [envelope.messageId])).toBe(1);
      await system.startApps(); await system.drain(); await system.state(wallet.id, '80.00', 3);
      system.evidence.push({ scenario: 'sigterm-inflight', productionContainer: name, drained: true, noNewPolls: true });
    } finally { if (!released) await lock.query('rollback'); lock.release(); await system.startApps(); }
  });

  test.serial('kill and restart all three apps with queued, pending-reference and outbox work plus in-flight requests', async () => {
    const wallet = await system.wallet(); const bet = system.wager(wallet); const refund = system.wager(wallet, 'REFUND', '25.00', bet.externalTransactionId);
    expect((await system.submit(refund)).status).toBe(202);
    await system.drain();
    const lock = await system.pool.connect(); await lock.query('begin'); await lock.query('select id from wallets where id=$1 for update', [wallet.id]);
    const inFlightBody = system.wager(wallet, 'WIN', '5.00'); const key = randomUUID();
    const inFlight = Promise.allSettled([system.submit(inFlightBody, key, 0)]);
    try {
      await eventually(() => system.count("select count(*) from pg_stat_activity where wait_event_type='Lock' and query ilike '%wallet%for update%'"), (n) => n > 0);
      await compose(system.project, ['kill', '-s', 'SIGKILL', 'app-a', 'app-b', 'app-c'], true);
    } finally { await lock.query('rollback'); lock.release(); }
    await inFlight;
    await system.send(system.envelope(bet));
    const fixture = await system.fixture('commit-before-publish', randomUUID()); await system.fixtureBarrier(fixture); await system.kill(fixture);
    expect(await system.count('select count(*) from outbox_messages where published_at is null')).toBeGreaterThan(0);
    expect(await system.count('select count(*) from wager_transactions where status=\'PENDING_REFERENCE\'')).toBe(1);
    expect(await system.queueSize()).toBe(1);
    await system.startApps(); expect((await system.submit(inFlightBody, key, 1)).status).toBe(200);
    await eventually(() => system.count('select count(*) from wager_transactions where status=\'PENDING_REFERENCE\''), (n) => n === 0);
    await system.drain(); await system.state(wallet.id, '105.00', 4);
    system.evidence.push({ scenario: 'full-restart', applicationsKilled: 3, sourceBefore: 1, pendingBefore: 1, outboxBefore: 2, finalBalance: '105.00' });
  });

  test.serial('predictable mixed workload on 12 wallets: 504 HTTP operations and exact final balances', async () => {
    await Promise.all(Array.from({ length: 12 }, async () => {
      const wallet = await system.wallet('200.00');
      for (let round = 0; round < 7; round++) {
        const bet = system.wager(wallet, 'BET', '10.00'); const key = randomUUID();
        expect((await system.submit(bet, key)).status).toBe(200);
        expect((await system.submit(system.wager(wallet, 'WIN', '3.00'))).status).toBe(200);
        expect((await system.submit(system.wager(wallet, 'LOSS', '0.00'))).status).toBe(200);
        const refund = system.wager(wallet, 'REFUND', '10.00', bet.externalTransactionId);
        expect((await system.submit(refund)).status).toBe(200);
        expect((await system.submit(system.wager(wallet, 'ROLLBACK', '10.00', refund.externalTransactionId))).status).toBe(200);
        expect((await system.submit(bet, key)).body.idempotentReplay).toBe(true);
      }
      await system.state(wallet.id, '151.00', 29);
    }));
    system.evidence.push({ scenario: 'mixed', wallets: 12, requests: 504, finalBalanceEach: '151.00', finalVersionEach: 29 });
  });

  test.serial('global SQL invariants, all committed events in SNS audit, zero pending work and reconciliation of every wallet', async () => {
    await system.invariants();
    for (const url of system.urls) {
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
      const metrics = await fetch(`${url}/metrics`); expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain('outbox');
    }
  });
});
