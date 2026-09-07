# Processamento SQS

Este documento descreve o contrato, a persistência e o ciclo de vida do consumer
SQS.

## Contrato e identidade

O consumidor aceita somente o envelope `WagerTransactionRequested`. O parser
valida JSON, chaves conhecidas, identificadores não vazios e sem padding,
timestamp ISO-8601 com data civil válida, `kind`, `money` e a referência exigida
por `REFUND`/`ROLLBACK`. `OPENING` é interno e, portanto, é rejeitado na fila.
O `occurredAt` identifica o instante do evento, mas o processamento financeiro
continua usando o relógio do próprio use case.

O nome estável do consumidor é `wager-transactions-v1`, configurável por
`SQS_CONSUMER_NAME`. A chave persistente é `(consumer_name, message_id)`; o
`MessageId` da AWS nunca é usado para a deduplicação da aplicação.

O `payload_hash` do Inbox é SHA-256 hexadecimal minúsculo do JSON canônico com:

- `messageId`, `type`, `occurredAt` normalizado e todos os campos aceitos de
  `data`, inclusive `idempotencyKey` e `money` em strings;
- chaves recursivamente ordenadas e propriedades opcionais ausentes omitidas.

Receipt handle, `MessageId` AWS, receive count, group/sequence e timestamps do
transporte ficam fora do hash. Esse hash é separado do hash financeiro usado
pela idempotency key.

## Transação e redelivery

Para uma mensagem nova, a ordem é:

```text
BEGIN
INSERT Inbox ON CONFLICT DO NOTHING
lock/read Inbox existente, quando houver
claim WagerTransaction
lock Wallet
persist WagerTransaction + Wallet + Ledger
persist OutboxMessage(s)
mark Inbox processed
COMMIT
DeleteMessage (ACK)
```

O `ProcessWagerTransactionUseCase.executeInContext()` reutiliza a mesma regra
financeira dentro do contexto já aberto pelo coordenador SQS. Não existe uma
segunda transação. Em conflito de inserção, o Inbox existente é carregado com
`FOR UPDATE`. Mesmo hash com `processed_at` retorna duplicata sem adquirir lock
financeiro; hash diferente gera `InboxPayloadConflictError` e DLQ.

Uma falha antes do commit reverte Inbox, wager, wallet, ledger e outbox. Uma falha ou
crash depois do commit e antes do ACK deixa a entrega reaparecer; a nova entrega
encontra o Inbox processado, não repete finanças e tenta o ACK novamente.

Resultados `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` e replay `FAILED` são
conclusões aceitas e recebem ACK. Conflitos de idempotência ou external ID são
terminais de negócio: o Inbox é marcado dentro da transação e recebe ACK.

## Retry e DLQ

Falhas desconhecidas e de infraestrutura usam `ApproximateReceiveCount` e
`ChangeMessageVisibility` com:

```text
min(SQS_RETRY_BASE_SECONDS * 2^(receiveCount - 1),
    SQS_RETRY_MAX_SECONDS)
```

O padrão é base 5 s, teto 300 s e máximo de 5 recebimentos. Ao atingir
`SQS_MAX_RECEIVE_ATTEMPTS`, a mensagem é enviada para a DLQ antes de ser
removida da fila de origem. Erros permanentes (envelope inválido, `OPENING`,
Inbox conflict, wallet inexistente/incompatível e resultado persistido
indisponível) vão imediatamente para a DLQ. Se o envio falhar, a origem não é
apagada.

A DLQ preserva o body original e recebe apenas os attributes seguros
`failureCategory` e `consumerName`. O `MessageGroupId` original é preservado
quando existe. O deduplication ID prefere o `messageId` lógico; para mensagens
não parseáveis usa `MessageId` AWS e, por último, SHA-256 do body. Identificadores
incompatíveis com os limites FIFO também são convertidos para SHA-256.

## Lifecycle

`WagerTransactionSqsConsumer` é provider NestJS e mantém o loop de long polling,
o `AbortController`, a flag de parada e as promises em andamento. O auto-start
é controlado por `SQS_CONSUMER_ENABLED` e fica desabilitado por padrão em
`NODE_ENV=test`. No shutdown, o consumer:

1. impede novos receives e aborta o long poll;
2. aguarda os handlers durante `SQS_SHUTDOWN_GRACE_MS` (padrão 10 s);
3. devolve `VisibilityTimeout=0` para receipts ainda ativos após o prazo.

Cada entrega possui sua própria transação PostgreSQL. O batch configurável é de
1 a 10 mensagens e não há mutex global; Inbox, idempotência financeira e o lock
por wallet são as garantias distribuídas.
