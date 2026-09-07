# Reconciliation, metrics and health

## Wallet reconciliation

`POST /wallets/:walletId/reconciliation` is a read-only diagnostic. The
controller maps HTTP and serializes `Money`; `ReconcileWalletUseCase` computes
the result; `WalletReconciliationPersistence` owns the database snapshot.

The PostgreSQL implementation starts a dedicated `REPEATABLE READ`, `READ
ONLY` transaction. It first reads the persisted wallet and then aggregates its
ledger without `FOR UPDATE`. Both queries therefore observe one MVCC snapshot
without delaying financial writers with a wallet row lock.

The ledger aggregate counts every entry and sums only entries whose currency
matches the wallet:

```text
CREDIT => +amount
DEBIT  => -amount
```

The `NUMERIC` result remains a decimal string until it is converted to
`Money`. A ledger entry in another currency raises an explicit integrity error;
currencies are never summed together and no FX conversion is attempted.

The result is defined as:

```text
storedBalance     = wallets.balance_amount
calculatedBalance = exact signed sum of wallet_ledger_entries.amount
difference        = storedBalance - calculatedBalance
consistent        = storedBalance.equals(calculatedBalance)
checkedEntries    = count of the wallet's ledger entries
```

A positive difference means the stored balance is higher than the ledger
balance. Reconciliation never calls wallet mutations, never updates either
table, never inserts an adjustment, and never creates an Outbox event.

A divergence returns `consistent: false`, increments
`wager_reconciliation_total{result="divergent"}`, and writes a warning with
only `walletId`, `checkedEntries`, `consistent`, and `outcome`. Monetary values
are intentionally absent.

## Prometheus metrics

`GET /metrics` refreshes gauges backed by PostgreSQL and SQS, then returns the
dedicated application `Registry` using `registry.contentType`. A collection
failure fails the scrape; it is not converted into a false zero. The endpoint
is open for this local challenge. A production deployment should restrict it
to the observability network.

| Metric | Type | Labels | Source and meaning |
|---|---|---|---|
| `wager_transactions_current` | Gauge | `status` | `GROUP BY status` over persisted wager transactions |
| `wager_duplicates_total` | Counter | `type` | committed business replay or committed Inbox duplicate |
| `wager_retries_total` | Counter | `component` | confirmed SQS visibility change, committed Outbox retry, or committed pending-reference retry |
| `wager_dlq_messages_visible` | Gauge | none | DLQ `ApproximateNumberOfMessages` from SQS |
| `wager_dlq_moves_total` | Counter | `reason` | successful `SendMessage` to the DLQ |
| `wager_wallet_lock_waiters` | Gauge | none | blocked PostgreSQL sessions waiting on a query containing `wallets ... FOR UPDATE` |
| `wager_outbox_lag_seconds` | Gauge | none | `max(now - min(occurred_at of unpublished messages), 0)`, or zero with no pending message |
| `wager_outbox_pending_messages` | Gauge | none | count of unpublished Outbox messages |
| `wager_processing_duration_seconds` | Histogram | `source`, `outcome` | monotonic application duration; buckets: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 seconds |
| `wager_reconciliation_total` | Counter | `result` | one increment for every completed consistent or divergent diagnostic |

Bounded label values are:

- `status`: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`;
- `type`: `business`, `inbox`;
- `component`: `sqs`, `outbox`, `pending_reference`;
- `reason`: `permanent`, `exhausted`;
- `source`: `direct`, `sqs`, `pending_reference`, `reconciliation`;
- `outcome`: `processed`, `rejected`, `pending_reference`, `replay`, `duplicate`, `error`;
- `result`: `consistent`, `divergent`.

No wallet, transaction, provider, message, event, correlation, external
transaction, or idempotency identifier is used as a metric label. Counters and
histograms are process-local observability only and never participate in
financial correctness.

## Structured logging and redaction

Confirmed direct processing logs transaction/correlation, wallet and provider
IDs, kind, status, failure code, replay flag, and outcome. The SQS boundary adds
message ID and receive count. The pending-reference worker adds attempt count.
The Outbox publisher preserves event ID, event type, aggregate ID, correlation
ID, attempts, and outcome.

Logs do not contain amount, money, stored/calculated balance, difference,
balance before/after, request or SQS bodies, Outbox payloads, payload hashes,
idempotency keys, authorization, or cookies. Pino redacts authorization,
cookies, set-cookie, idempotency-key and request bodies as defense in depth.

## Health policy

`GET /health/live` checks only that the application process is running. It does
not call PostgreSQL, SQS, SNS, Outbox, DLQ, or reconciliation.

`GET /health/ready` executes a real PostgreSQL `SELECT 1` and a real SQS
`GetQueueAttributes` against the configured main queue. SNS is excluded because
the transactional Outbox permits financial commits while publication is
temporarily unavailable. Outbox lag, DLQ depth, and wallet divergence are
operational signals exposed by logs and metrics, not readiness dependencies.
