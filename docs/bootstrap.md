# Bootstrap local

O `README.md` da raiz permanece a especificação oficial. Este arquivo documenta
somente a execução da infraestrutura criada na Etapa 1.

## Pré-requisitos

- Bun 1.x;
- Docker com Docker Compose v2.

## Aplicação no host

1. Copie `.env.example` para `.env`.
2. Execute `bun install`.
3. Suba PostgreSQL e LocalStack com
   `docker compose up -d postgres localstack`.
4. Consulte migrations com `bun run migration:status`.
5. Inicie a aplicação com `bun run start:dev`.

`GET /health/live` verifica apenas que o processo responde. `GET /health/ready`
executa uma consulta real no PostgreSQL e lê atributos da fila SQS principal.

## Ambiente completo em containers

Execute `docker compose up --build`. O serviço da aplicação aguarda os
healthchecks de PostgreSQL e LocalStack antes de iniciar.

O hook de inicialização do LocalStack cria, de forma idempotente:

- `wager-transactions.fifo` com redrive após 5 recebimentos;
- `wager-transactions-dlq.fifo`;
- o tópico `wager-integration-events`;
- a fila standard `wager-integration-events-audit`, sua policy e a inscrição no
  tópico com raw message delivery.

A migration da Etapa 3 cria `wallets`, `wager_transactions` e
`wallet_ledger_entries`, incluindo as constraints financeiras e a proteção de
imutabilidade do ledger. Execute-a com `bun run migration:up` e consulte seu
estado com `bun run migration:status`.

A migration da Etapa 7 acrescenta `inbox_messages`. O consumer real de
`wager-transactions.fifo` inicia junto com o NestJS quando
`SQS_CONSUMER_ENABLED=true`. As configurações de polling, batch, retry, limite
de recebimentos e grace period estão documentadas em `.env.example`; a
semântica completa está em `docs/sqs-processing.md`.

A migration da Etapa 8 acrescenta `outbox_messages`, seus checks de estado e o
índice parcial de mensagens pendentes. O `OutboxPublisherWorker` inicia junto
com o NestJS quando `OUTBOX_PUBLISHER_ENABLED=true`, reclama uma row por
transação com `FOR UPDATE SKIP LOCKED` e publica no tópico configurado por
`INTEGRATION_EVENTS_TOPIC_ARN`. `OUTBOX_BATCH_SIZE` e
`OUTBOX_POLL_INTERVAL_MS` controlam o loop; `OUTBOX_RETRY_BASE_MS` e
`OUTBOX_RETRY_MAX_MS` controlam o backoff persistente. Em `NODE_ENV=test`, o
auto-start do publisher fica desabilitado por padrão. O ciclo completo está em
`docs/outbox-processing.md`; a fila `wager-integration-events-audit` valida o
body raw publicado pelo SNS.

## Testes

- `bun run test` ou `bun run test:unit`: testes rápidos da fundação;
- `bun run test:integration`: testes de integração, ignorados por padrão;
- `RUN_INTEGRATION_TESTS=true bun run test:integration`: usa PostgreSQL e
  LocalStack reais configurados no ambiente. Os testes financeiros criam e
  removem um banco PostgreSQL descartável, portanto o usuário configurado
  precisa de permissão para `CREATE DATABASE`;
- `bun run test:concurrency`: concorrência financeira em PostgreSQL real,
  habilitada também por `RUN_INTEGRATION_TESTS=true`. Usa bancos descartáveis
  para provar disputa pela mesma wallet e locks independentes entre wallets;
- `bun run test:all`: executa toda a suíte descoberta pelo Bun Test.
