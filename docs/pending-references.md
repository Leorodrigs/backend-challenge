# Pending references

`REFUND` and `ROLLBACK` resolve their reference by the composite key
`(providerId, referenceExternalTransactionId)`. After locking the operation's
wallet, processing validates the wallet player and currency, then the reference
kind, provider, player, wallet, currency, round, status, exact amount, and prior
processed reversal of the same kind. `gameId` is intentionally not part of the
reference context required by the challenge.

An absent reference, or a structurally compatible reference still in `PENDING`
or `PENDING_REFERENCE`, persists the same transaction as `PENDING_REFERENCE`.
The row stores the balance/version snapshot observed on its first unresolved
attempt plus `reference_attempt_count`, `reference_next_attempt_at`, and
`reference_deadline_at`. An HTTP/application replay returns that stored snapshot
and does not attempt resolution again.

Attempt `1` is the initial unresolved lookup. Each committed worker lookup that
remains unresolved increments the count. The default policy uses a 1 second base
delay, a 60 second cap, 1,440 maximum attempts, and a 24 hour absolute TTL:

```text
delay = min(baseDelay * 2^(attempt - 1), maxDelay)
```

The next attempt is capped at the absolute deadline. The deadline is created
once and is not extended by retries. Reaching either budget boundary produces
`REJECTED / REFERENCE_NOT_FOUND`, as specified by README section 7.1. A terminal
decision clears the next-attempt and deadline fields while preserving the count
for audit.

The scheduled worker calls `runOnce()`. Each item has its own SQL transaction and
is claimed with `FOR UPDATE SKIP LOCKED`, ordered by due time, creation time, and
id. Inside that transaction the existing wager row remains locked, its wallet is
locked with ordinary `FOR UPDATE`, the reference is resolved, and transaction,
snapshot, retry state, wallet, and ledger are committed together. A process crash
or exception rolls the transaction back, releases both locks, and consumes no
attempt or financial effect. `SKIP LOCKED` is only used for pending-job claims;
wallet financial locks wait normally.

Processed reversals are unique by `(reference_transaction_id, kind)`. The
application checks this after the wallet lock, and PostgreSQL enforces it with a
partial unique index limited to processed `REFUND` and `ROLLBACK` rows.
