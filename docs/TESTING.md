# Testes

## Comandos

```sh
bun install --frozen-lockfile
bun run build
bun node_modules/typescript/bin/tsc --noEmit --incremental false
bun run test:unit
bun scripts/audit-static.ts
bun run test:distributed
bun run test:final
```

`test:final` executa instalação congelada, build, descoberta offline de runtime,
TypeScript strict, testes unitários, verificações estáticas, build Docker sem
cache, integração, concorrência, migrations, smoke HTTP/SQS e testes
distribuídos. O comando termina com `git diff --check`.

Os testes de infraestrutura usam um projeto definido por
`compose.distributed.yml`, com rede, volumes e portas loopback isolados. O
PostgreSQL usa uma porta reservada por execução, e as portas das aplicações são
descobertas novamente após reinícios. Containers, rede e volumes são removidos
ao final, inclusive quando ocorre uma falha.

O executor não repete falhas de assertions. Somente um crash nativo do Bun por
sinal ou exit 3 pode receber até três tentativas. A primeira usa `--smol`; as
seguintes usam o heap normal. Logs e resultados para diagnóstico ficam em
`test-results/`, que é ignorado pelo Git.

## Resultados principais

| Tipo | Escopo | Resultado |
|---|---|---|
| Unitários | Domínio, casos de uso, parsers, workers, health e métricas | PASS |
| Integração | Persistência financeira, PostgreSQL, SQS/SNS e endpoints | PASS |
| Concorrência | Idempotência, hot wallet, wallets independentes e publishers | PASS |
| Distribuídos | Três aplicações, falhas reais, reinícios e invariantes globais | PASS |
| Migrations | Banco novo, down/up, status, check e dump | PASS |
| Smoke | Wallet, BET, replay, consultas, SQS, reconciliação, health e métricas | PASS |
| `test:final` | Fluxo completo em ambiente isolado | PASS |

## Infraestrutura utilizada

| Serviço | Uso nos testes |
|---|---|
| PostgreSQL 18.6 Alpine | Banco real e saudável, com porta isolada/dinâmica |
| LocalStack 4.14.0 | SQS e SNS reais, com porta isolada/dinâmica |
| `app-a`, `app-b`, `app-c` | Três containers e processos independentes |
| `migrate` | Aplica as migrations antes das aplicações |

As três aplicações usam a mesma imagem, mas possuem processos, consumers,
publishers e portas independentes. PostgreSQL e LocalStack são compartilhados
entre elas durante cada cenário distribuído.

## Contratos HTTP

| Método | Path | Sucesso | Erros |
|---|---|---|---|
| POST | `/wallets` | 201 | 400, 409, 503, 500 |
| GET | `/wallets/:walletId` | 200 | 400, 404, 503, 500 |
| GET | `/wallets/:walletId/ledger?cursor=&limit=50` | 200 | 400, 404, 503, 500 |
| POST | `/wagering/transactions` | 200 processada/replay; 202 pendente | 400, 404, 409, 422 rejeitada, 503, 500 |
| GET | `/wagering/transactions/:transactionId` | 200 | 400, 404, 503, 500 |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | 400, 404, 503, 500 |
| POST | `/wallets/:walletId/reconciliation` | 200 diagnóstico | 404, 409 moeda corrompida, 503, 500 |
| GET | `/health/live` | 200 | Independente de banco/broker |
| GET | `/health/ready` | 200 | 503 dependência indisponível |
| GET | `/metrics` | 200 texto Prometheus | 503/500 se a coleta falhar |

Não envie `cursor=` vazio; omita o parâmetro na primeira página. Uma rejeição
persistida retorna transactionId, status, failureCode, balance, walletVersion e
replay. Um erro de transporte não é uma transação financeira rejeitada. O
header `Idempotency-Key` é obrigatório no POST de wager e não é aceito no body
HTTP.

## Matriz de requisitos

Abreviações: U = `test/unit`; I = `test/integration`; C = `test/concurrency`;
D = `test/distributed/financial-system.distributed.spec.ts`.

| Requisito | Cobertura | Resultado |
|---|---|---|
| Bun, instalação congelada e TypeScript strict | build, descoberta de runtime e `tsc --noEmit` | PASS |
| NestJS, MikroORM e PostgreSQL real | build, I, C e boot de A/B/C | PASS |
| LocalStack, SQS e SNS reais | I e D com filas, tópico e subscription | PASS |
| Migrations versionadas e reversíveis | fresh up, down/up, check, dump e status | PASS |
| Domínio encapsulado | U de domínio e I de persistência | PASS |
| `Money` imutável e decimal em string | parser estrito, `decimal.js` e U | PASS |
| `NUMERIC(20,2)` exato além de IEEE-754 | `ExactDecimalType`, I e D | PASS |
| Wallet única por player/moeda | índice único e criações concorrentes em A/B/C | PASS |
| Saldo não negativo | domínio, checks SQL, C e hot wallet em D | PASS |
| Saldo e ledger atômicos | I e checker financeiro | PASS |
| Lock pessimista por wallet | C e D com operações em três instâncias | PASS |
| Wallets distintas progridem em paralelo | C e D com uma wallet bloqueada | PASS |
| Versão acompanha mudanças reais de saldo | I e checker de continuidade | PASS |
| OPENING interno e atômico | parser, API, wallet, transação, ledger e Outbox | PASS |
| BET, WIN e LOSS | U, I e workload distribuído | PASS |
| REFUND, ROLLBACK e referências fora de ordem | U, I, C e D | PASS |
| Reversão única por tipo | índice parcial e races concorrentes | PASS |
| Ledger imutável | trigger de UPDATE/DELETE exercitado no PostgreSQL | PASS |
| Aritmética, moeda e cardinalidade do ledger | constraints e checker financeiro | PASS |
| Idempotência persistente | claim SQL, índices, chamadas paralelas e restart | PASS |
| Payload divergente gera conflito | hash canônico e race entre instâncias | PASS |
| Provider/external único | índice e race entre instâncias | PASS |
| Replay preserva o snapshot original | I e replay em A/B/C após nova operação | PASS |
| `PENDING_REFERENCE` persistente | worker com `SKIP LOCKED`, I, SQS e restart | PASS |
| Backoff, TTL e tentativas persistentes | U e I | PASS |
| Inbox e efeito financeiro na mesma transação | I e crash entre commit e ACK | PASS |
| Deduplicação Inbox entre consumers | I, C e SQS real | PASS |
| ACK somente depois do commit | kill do consumer e redelivery | PASS |
| Retry e DLQ | I, outage e fila real | PASS |
| Transactional Outbox | I e crashes nas janelas de publicação | PASS |
| Publishers concorrentes | `FOR UPDATE SKIP LOCKED`, C e três apps | PASS |
| `eventId` estável na republicação | entregas repetidas com o mesmo envelope | PASS |
| API HTTP | smoke e contratos distribuídos | PASS |
| Cursor keyset do ledger | timestamps empatados, múltiplas páginas e sem duplicata | PASS |
| Reconciliação read-only | I, C, smoke e checker financeiro | PASS |
| Logs e redaction | U e logs dos containers | PASS |
| Métricas | U, I, C e scrape das três apps | PASS |
| Liveness e readiness | I e outages de PostgreSQL/LocalStack | PASS |
| Shutdown gracioso | U e SIGTERM de container | PASS |
| Reinício completo | recuperação de fila, referência e Outbox | PASS |
| Autenticação opcional | decisão e ponto de extensão documentados | PASS documental |

## Cenários distribuídos

| Cenário | Resultado |
|---|---|
| Decimal exato | Um débito de `0.01` sobre `9007199254740993.37` persiste `9007199254740993.36` sem conversão para `number` |
| Criação concorrente | Apenas uma wallet e uma operação `OPENING` são criadas; as demais chamadas recebem 409 |
| 50 BETs idênticas | Uma operação original, 49 replays, um DEBIT e um único `transactionId` |
| Hot wallet | Duas BETs concorrentes de `80.00` sobre saldo `100.00` resultam em uma processada, uma rejeitada e saldo `20.00` |
| Wallets distintas | Operações em outras wallets confirmam enquanto uma wallet permanece sob `FOR UPDATE` |
| Conflitos | A mesma chave com payload diferente e provider/external repetido produzem 409 sem débito extra |
| Cursor do ledger | Paginação keyset cobre todas as entradas, inclusive timestamps iguais, sem saltos ou duplicatas |
| Inbox e três consumers | Mensagens reais são distribuídas entre `app-a`, `app-b` e `app-c`; duplicatas não repetem o efeito financeiro |
| Referências fora de ordem | REFUND e ROLLBACK permanecem em `PENDING_REFERENCE` e são resolvidos quando a referência chega |
| Races de reversão | Apenas uma reversão de cada tipo é processada |
| Commit antes do ACK | Após a morte do consumer, a redelivery encontra a Inbox confirmada e não repete saldo, ledger ou Outbox |
| Crash da Outbox | A recuperação publica linhas pendentes e reutiliza o mesmo `eventId` quando o SNS confirmou antes de `published_at` |
| PostgreSQL indisponível | Liveness continua 200, readiness e HTTP financeiro retornam 503, e a mensagem é processada após a recuperação |
| LocalStack indisponível | O commit financeiro continua; a Outbox permanece pendente e publica após a recuperação |
| SIGTERM | Trabalho em andamento termina dentro do prazo, novos polls param e mensagens restantes são retomadas por outra instância |
| Reinício completo | Inbox, Outbox e referências pendentes retomam do estado persistido |
| Workload misto | BET, WIN, LOSS, REFUND, ROLLBACK e replay mantêm saldo, versão e ledger consistentes |

Os cenários de Outbox validam entrega at-least-once. Quando ocorre republicação,
o `eventId` e o payload permanecem estáveis para deduplicação pelo consumidor.

## Invariantes verificadas

O checker distribuído consulta o PostgreSQL diretamente e também usa o endpoint
de reconciliação. Nenhuma violação foi encontrada em:

```text
wallet_ledger_sum
money_and_currency
ledger_arithmetic
ledger_transaction
ledger_cardinality
wallet_version
ledger_continuity
snapshot_nonnegative
duplicate_reversal
incomplete_inbox
incomplete_work
DLQ
reconciliation divergences
```

O checker também compara os envelopes persistidos na Outbox com as entregas SNS.
Entregas adicionais são republicações at-least-once e preservam o mesmo payload
para cada `eventId`.

## Migrations

Os testes aplicam todas as migrations em um banco novo, executam o ciclo completo
de down/up e consultam `migration:status`. `migration:check` e
`migration:create --dump` confirmam que o schema está atualizado. Nenhuma
migration histórica é reescrita durante o teste.

## Verificações estáticas

`scripts/audit-static.ts` localiza conversões numéricas, coleções em memória,
publicação e locks. As conversões produtivas tratam limites, contagens, lag,
datas, configuração e serialização Decimal; nenhuma representa dinheiro.
Map/Set são usados para coordenação local e validação, não para garantir
idempotência. O único `PublishCommand` produtivo pertence ao adapter SNS da
Outbox.

## Diagnóstico de falhas

Uma falha deve ser investigada pela primeira divergência de `transactionId`,
`walletId`, `messageId` ou `eventId`. Polling com deadline serve apenas para
aguardar condições eventuais, como health, fila e entrega SNS. Assertions
financeiras não recebem retry. Fixtures de crash existem somente no target de
teste.

O benchmark de carga é opcional e não está incluído.
