# Transactional Outbox e SNS

O `README.md` da raiz permanece a especificação oficial. Este documento registra
as decisões da Etapa 8.

## Contratos dos eventos

Todos os eventos usam o envelope `IntegrationEvent`, `version: 1`, datas
ISO-8601 e DTOs JSON explícitos. Valores monetários são sempre `MoneyProps`:

```json
{ "amount": "25.00", "currency": "BRL" }
```

`WagerTransactionProcessed.data`:

```text
transactionId, providerId, externalTransactionId, walletId, playerId,
roundId, gameId, kind, money,
referenceExternalTransactionId? e referenceTransactionId?
```

`WagerTransactionRejected.data`:

```text
transactionId, providerId, externalTransactionId, walletId, playerId,
roundId, gameId, kind, money, failureCode,
referenceExternalTransactionId?
```

`WagerTransactionPendingReference.data`:

```text
transactionId, providerId, externalTransactionId, walletId, playerId,
roundId, gameId, kind, money, referenceExternalTransactionId
```

`WalletBalanceChanged.data` segue diretamente o contrato do README:

```text
walletId, transactionId, direction, money, balanceBefore, balanceAfter,
walletVersion
```

Os campos dos três eventos de wager são a projeção mínima escolhida para
identificar e interpretar a operação sem serializar o aggregate inteiro. Os
campos de referência opcionais só aparecem quando existem.

## Identidade e correlação

- `eventId` é um UUID criado uma única vez ao construir o evento;
- `OutboxMessage.id` é o próprio `eventId`;
- eventos de wager usam `WagerTransaction.id` como `aggregateId`;
- `WalletBalanceChanged` usa `Wallet.id` como `aggregateId`;
- todos os eventos da operação usam `WagerTransaction.id` como
  `correlationId`, inclusive quando o worker resolve a referência depois;
- eventos de wager omitem `causationId`; `WalletBalanceChanged` usa o
  `transactionId` como causa.

Consumidores devem persistir e deduplicar por `eventId`. A entrega é
at-least-once: uma falha depois de `SNS Publish` e antes do commit de
`published_at` causa republicação intencional do mesmo envelope e do mesmo ID.

## Geração atômica

`ClaimedWagerTransactionProcessor` compara o status anterior e o status final.
Ele cria `Processed`, `Rejected` ou `PendingReference` somente quando ocorre uma
transição. `WalletBalanceChanged` só é criado quando existe um
`WalletLedgerEntry`. Cada evento é convertido em `OutboxMessage` no mesmo
`EntityManager` transacional usado por wager, wallet, ledger e Inbox.

```text
BEGIN
Inbox, quando a origem é SQS
WagerTransaction
Wallet
WalletLedgerEntry
OutboxMessage(s)
Inbox processed, quando a origem é SQS
COMMIT
ACK SQS
```

Replay por idempotency key retorna antes do processor; redelivery encontra o
Inbox processado; retry ainda `PENDING_REFERENCE` não muda de status. Esses três
caminhos não criam um novo evento.

## Persistência e retry

`outbox_messages` mantém o envelope em `payload JSONB`. Uma mensagem nova tem
`attempts = 0`, `next_attempt_at = occurred_at` e `published_at = null`.
`attempts` conta somente falhas confirmadas de publicação. O retry é indefinido,
sem DLQ e com backoff configurável:

```text
delay = min(OUTBOX_RETRY_BASE_MS * 2^(attempts - 1), OUTBOX_RETRY_MAX_MS)
```

O padrão é base de 1 s e teto de 60 s; o expoente é limitado para evitar
overflow. Sucesso preenche `published_at` e limpa `next_attempt_at`. Linhas
publicadas não são apagadas.

## Publisher e locking

`OutboxPublisherWorker.runOnce()` processa até `OUTBOX_BATCH_SIZE`, com uma
transação PostgreSQL por item:

```sql
select id
from outbox_messages
where published_at is null
  and next_attempt_at <= ?
order by next_attempt_at, occurred_at, id
limit 1
for update skip locked;
```

O lock permanece durante a chamada SNS. Esse trade-off mantém o protocolo
simples e impede dois publishers de publicar simultaneamente a mesma row, sem
bloquear wallets ou outras rows. Se SNS falha, `scheduleRetry()` e `save()` são
confirmados sem relançar o erro dentro da transação. Se o banco falha, a
transação faz rollback e a row continua pendente no estado anterior.

O loop usa `OUTBOX_POLL_INTERVAL_MS`, impede overlap local apenas para a mesma
instância e, no shutdown, para novas iterações e aguarda a atual. A garantia
distribuída continua sendo `FOR UPDATE SKIP LOCKED`. O auto-start é controlado
por `OUTBOX_PUBLISHER_ENABLED`, habilitado por padrão fora de `NODE_ENV=test`.

## SNS

`SnsIntegrationEventPublisher` reutiliza o `SNSClient` singleton exposto por
`SNS_CLIENT` e publica em `INTEGRATION_EVENTS_TOPIC_ARN`. `PublishCommand.Message`
é o envelope persistido serializado como JSON canônico. Os attributes contêm
somente `eventId`, `eventType`, `aggregateId` e `correlationId`.

O bootstrap LocalStack mantém `wager-integration-events-audit` inscrita no
tópico `wager-integration-events` com raw delivery. Portanto o body lido da fila
é diretamente o envelope do Integration Event, sem wrapper SNS.
