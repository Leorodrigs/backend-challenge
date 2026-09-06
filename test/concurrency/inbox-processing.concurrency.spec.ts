import { describe, expect, test } from 'bun:test';

import { ProcessWagerSqsMessageUseCase } from '../../src/messaging/sqs/process-wager-sqs-message.use-case.js';
import { WagerTransactionRequestedParser } from '../../src/messaging/sqs/wager-transaction-requested.parser.js';
import { MikroOrmWagerProcessingPersistence } from '../../src/persistence/mikro-orm/mikro-orm-wager-processing.persistence.js';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.js';
import {
  createWagerProcessingDatabase,
  type WagerProcessingDatabase,
} from '../helpers/wager-processing-database.js';
import {
  expectWalletState,
  loadLedger,
  seedWallet,
  wagerInput,
} from '../helpers/wager-processing-fixtures.js';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'concurrent PostgreSQL Inbox claims',
  () => {
    test('two transactions claiming the same logical message produce one owner and one duplicate', async () => {
      let database: WagerProcessingDatabase | undefined;
      try {
        database = await createWagerProcessingDatabase();
        const wallet = await seedWallet(database);
        const input = wagerInput(wallet, WagerTransactionKind.Bet);
        const envelope = new WagerTransactionRequestedParser().parse(
          JSON.stringify({
            messageId: 'concurrent-msg',
            type: 'WagerTransactionRequested',
            occurredAt: '2026-09-05T12:00:00.000Z',
            data: {
              idempotencyKey: input.idempotencyKey,
              ...input.payload,
              money: input.payload.money.toJSON(),
            },
          }),
        );
        const useCases = Array.from({ length: 2 }, () => {
          const persistence = new MikroOrmWagerProcessingPersistence(
            database!.orm.em.fork(),
          );
          return new ProcessWagerSqsMessageUseCase(
            persistence,
            new ProcessWagerTransactionUseCase(persistence),
            'wager-transactions-v1',
          );
        });

        const results = await Promise.all(
          useCases.map((useCase) => useCase.execute(envelope)),
        );

        expect(results.filter(({ outcome }) => outcome === 'PROCESSED')).toHaveLength(1);
        expect(results.filter(({ outcome }) => outcome === 'DUPLICATE')).toHaveLength(1);
        const inbox = await database.pool.query(
          `select consumer_name, message_id, processed_at
           from inbox_messages where message_id = $1`,
          [envelope.messageId],
        );
        expect(inbox.rows).toHaveLength(1);
        expect(inbox.rows[0]?.processed_at).toBeInstanceOf(Date);
        expect((await loadLedger(database, input)).rows).toHaveLength(1);
        await expectWalletState(database, wallet, '75.00', 2);
      } finally {
        await database?.close();
      }
    }, 30_000);
  },
);
