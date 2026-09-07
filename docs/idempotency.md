# Idempotência persistente

`README.md` permanece a especificação oficial. Este fluxo processa BET, WIN e
LOSS e recebe `{ idempotencyKey, payload }`. O ID interno é um `randomUUID()`
gerado pela aplicação a cada tentativa; `createdAt` também é interno. O chamador
não fornece `payloadHash`.

## JSON canônico e SHA-256

`WagerPayloadHasher` seleciona explicitamente os campos de negócio:

- `providerId`, `externalTransactionId`, `playerId`, `walletId`;
- `roundId`, `gameId`, `kind`;
- `money.amount`, `money.currency`, usando `Money.toJSON()`;
- `referenceExternalTransactionId`, quando presente.

A key, ID interno, hash recebido, datas geradas, correlation/trace IDs, headers,
messageId, receive count e demais metadados de transporte são excluídos, mesmo
se aparecerem como propriedades extras em runtime.

`canonicalizeJson` ordena as chaves recursivamente com `Array.sort()` (ordem
lexicográfica por unidades UTF-16, sem locale). Emite cada membro diretamente,
inclusive para chaves como `"10"` e `"2"`, evitando a reordenação numérica de
propriedades feita por objetos JavaScript. Arrays mantêm sua ordem. Strings
usam o escape de `JSON.stringify`; booleanos e `null` são preservados. Não há
normalização Unicode. O componente aceita valores JSON finitos e acíclicos,
com objetos simples; não é uma implementação completa de RFC 8785/JCS.

Propriedades de objetos com `undefined` são omitidas: ausente e `undefined`
opcional têm o mesmo significado. `null` é distinto. `undefined` no valor raiz,
em arrays ou em posições vazias de arrays é rejeitado, assim como valores não
JSON (por exemplo, `Date`, `BigInt`, função, `NaN` ou infinito).

`money.amount` permanece uma string decimal com duas casas (`"25.00"`), nunca
um número JSON. O JSON canônico é codificado em UTF-8 e submetido a SHA-256
por `createHash('sha256').update(canonical, 'utf8').digest('hex')`: 64 caracteres
hexadecimais minúsculos. Não há biblioteca nova nem estado em memória usado
para garantir idempotência.

## Claim e transação financeira

PostgreSQL é a fonte da verdade. As constraints existentes
`wager_transactions_idempotency_key_unique` e
`wager_transactions_provider_external_unique` continuam imediatas e únicas.
Cada execução usa um EntityManager isolado e uma transação `READ COMMITTED`.

O repositório usa `EntityManager.execute` com parâmetros vinculados e a mesma
conexão transacional para:

```sql
SET CONSTRAINTS wager_transactions_wallet_fk DEFERRED;
INSERT INTO wager_transactions (...) VALUES (...)
ON CONFLICT DO NOTHING RETURNING id;
```

O INSERT grava a candidata `PENDING`. Só quem recebe a linha em `RETURNING`
segue para o lock da wallet. As transações concorrentes são coordenadas pelas
constraints únicas. Se a vencedora confirma, a perdedora não insere; a consulta
seguinte em `READ COMMITTED` enxerga o resultado confirmado. Se a vencedora
aborta, sua claim desaparece e outra tentativa pode inserir. O comportamento
de `ON CONFLICT` e `RETURNING` está descrito na
[documentação do PostgreSQL](https://www.postgresql.org/docs/current/sql-insert.html).

Sem linha inserida, a classificação segue esta ordem:

1. Consulta por key; `matchesPayload()` compara o hash persistido.
2. Hash igual retorna replay; hash diferente lança `IdempotencyConflictError`.
3. Sem a key, consulta provider/external; lança `ExternalTransactionConflictError`
   se a operação pertence a outra key. Isso não é replay.
4. Outra colisão estrutural lança `WagerClaimConflictError`; não há tentativa de
   adivinhar a causa por texto de erro SQL.

Replay e conflito encerram antes de qualquer `wallet FOR UPDATE`. Nenhum deles
altera a transação original, saldo, versão ou ledger.

O caminho vencedor segue:

```text
BEGIN → claim PENDING → wallet FOR UPDATE → validar player/moeda
→ BET/WIN/LOSS → estado final + snapshot → wallet e ledger se houve movimento
→ COMMIT
```

O hash é calculado antes do BEGIN, pois não depende do banco. Todos os efeitos
persistentes acima participam da mesma transação. Rejeições por insuficiência
ou moeda também recebem snapshot e commit; falhas inesperadas propagam e
revertem claim, saldo, ledger e snapshot. A resposta só é entregue depois do
commit. Não há retry automático nem resultado persistido para falha sem commit.

### FK da claim e locks

Inserir a claim com a FK imediata pode adquirir `KEY SHARE` na wallet antes
do `FOR UPDATE`. Duas operações distintas poderiam então disputar a promoção
desses locks. A migration torna apenas `wager_transactions_wallet_fk`
`DEFERRABLE INITIALLY IMMEDIATE`; o repositório adia sua verificação somente na
transação da claim. A FK é obrigatória no commit e mantém `ON UPDATE RESTRICT`
e `ON DELETE RESTRICT`. As demais constraints permanecem intactas. Os modos
de verificação são descritos em
[CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html).

O teste de duas claims distintas usa uma barreira depois de ambos os INSERTs
e antes dos locks da wallet, para comprovar ausência desse deadlock. O teste
de FK também tenta confirmar uma claim sem wallet e exige a falha no commit.

## Snapshot e replay fiel

O snapshot pertence à aplicação/persistência, sem modificar os aggregates:

| Coluna em `wager_transactions` | PostgreSQL |
|---|---|
| `result_balance_amount` | `NUMERIC(20,2)` nullable |
| `result_balance_currency` | `VARCHAR(3)` nullable |
| `result_wallet_version` | `INTEGER` nullable |

Os CHECKs exigem all-or-none, saldo não negativo e diferente de `NaN`, moeda
`^[A-Z]{3}$` e versão >= 1. `DecimalType('string')` conserva o round-trip
NUMERIC → string → `Money`, sem conversão monetária para `number`.

O replay combina ID, status e failureCode da `WagerTransaction` reidratada
com saldo/moeda/versão do snapshot e `idempotentReplay: true`. Nenhuma transição
de domínio é repetida. `ledgerEntryId`, quando existe, é reconstruído pelo
ledger imutável e único por wallet/transação; o ledger não guarda o snapshot.
LOSS, operações zero e REJECTED têm snapshot mesmo sem ledger.

Exemplo: BET 25,00 em wallet 100,00 retorna 75,00/versão 2. Um WIN posterior
leva a wallet a 125,00/versão 3; o retry da BET ainda retorna 75,00/versão 2.
Uma BET rejeitada com saldo 20,00 permanece rejeitada com esse saldo observado,
mesmo após um WIN de 100,00. Moeda divergente retorna a moeda/saldo da wallet
observada, não a moeda rejeitada da operação.

### Registros anteriores e estados não terminais

Não há backfill: não é possível reconstruir arbitrariamente o saldo original
de LOSS e rejeições anteriores usando o saldo atual. Colunas nullable preservam
esses registros. Se o hash coincide mas o snapshot não existe, a aplicação lança
`WagerResultUnavailableError` com transactionId/status, tanto para terminais
quanto para não terminais. Nenhum saldo é inventado ou reaplicado. Hashes legados
arbitrários também não são recalculados; divergência segue sendo conflito.

Um registro com snapshot pode ser lido sem exigir transição nem terminalidade;
isso mantém o contrato extensível a estados pendentes futuros. A resolução de
referências pendentes fica a cargo do worker específico. Uma eventual reversão
da migration remove os snapshots, portanto perde a capacidade de replay desses
resultados.

## Testes

Os testes unitários cobrem canonicalização, hashing e desvios do fluxo antes
do wallet lock. Os testes PostgreSQL cobrem resultados históricos, rejeições,
precisão acima de IEEE-754, constraints, registros antigos e rollback da claim.

`bun run test:concurrency`, com `RUN_INTEGRATION_TESTS=true`, dispara 50 chamadas
idênticas e observa espera real de lock na claim. Cada chamada gera um ID
candidato distinto e usa EntityManager/transação independentes. As asserções
exigem 50 fulfilled, 0 rejected, 1 original, 49 replays, 1 ID retornado, 1
WagerTransaction da request, 1 DEBIT, saldo 75,00 e versão 2, além de exatamente
um `wallet FOR UPDATE`. O CREDIT de abertura é somente fixture.

Os testes também cobrem payloads divergentes, provider/external concorrentes e
reconstroem o saldo pelo ledger com decimal exato. Todos os ORMs descartáveis
usam `migrations.snapshot = false`.
