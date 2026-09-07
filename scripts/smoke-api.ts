import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { eventually } from './docker.js';

const base = process.argv[2] ?? 'http://localhost:3000';
async function request(path: string, method = 'GET', value?: object, key?: string, expected = 200): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json',
    ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(10000) });
  const body: unknown = await response.json();
  if (response.status !== expected || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${method} ${path}: unexpected status ${response.status}`);
  }
  return body as Record<string, unknown>;
}
const playerId = `smoke-${randomUUID()}`;
const wallet = await request('/wallets', 'POST', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }, undefined, 201);
if (typeof wallet.id !== 'string') throw new Error('Wallet ID missing');
const body = { providerId: 'smoke-provider', externalTransactionId: randomUUID(), playerId, walletId: wallet.id,
  roundId: wallet.id, gameId: 'smoke-game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
const key = randomUUID();
const transaction = await request('/wagering/transactions', 'POST', body, key);
const replay = await request('/wagering/transactions', 'POST', body, key);
if (replay.idempotentReplay !== true || replay.transactionId !== transaction.transactionId) throw new Error('Replay mismatch');
await request(`/wallets/${wallet.id}`);
await request(`/wallets/${wallet.id}/ledger?limit=1`);
await request(`/wagering/transactions/${String(transaction.transactionId)}`);
await request(`/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`);
const externalTransactionId = randomUUID();
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL, useQueueUrlAsEndpoint: false } : {}) });
try {
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.WAGER_QUEUE_URL!, MessageGroupId: wallet.id,
    MessageDeduplicationId: randomUUID(), MessageBody: JSON.stringify({ messageId: randomUUID(), type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(), data: { ...body, externalTransactionId, idempotencyKey: randomUUID(), kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } } }) }));
  await eventually(() => request(`/providers/${body.providerId}/wagering/transactions/${externalTransactionId}`), (result) => result.status === 'PROCESSED');
} finally { sqs.destroy(); }
const reconciliation = await request(`/wallets/${wallet.id}/reconciliation`, 'POST');
if (reconciliation.consistent !== true) throw new Error('Reconciliation failed');
await request('/health/live'); await request('/health/ready');
const metrics = await fetch(`${base}/metrics`);
if (!metrics.ok || !(await metrics.text()).includes('outbox')) throw new Error('Metrics unavailable');
console.log(JSON.stringify({ smoke: 'PASS', walletId: wallet.id, transactionId: transaction.transactionId, reconciliation }, null, 2));
