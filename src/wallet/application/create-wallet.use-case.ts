import { randomUUID } from 'node:crypto';

import { Money } from '../../shared/domain/value-objects/money.js';
import { OutboxMessage } from '../../messaging/outbox/domain/outbox-message.js';
import { WagerTransaction } from '../../wagering/domain/wager-transaction.js';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../wagering/domain/wager-transaction-status.js';
import { WagerPayloadHasher } from '../../wagering/application/wager-payload-hasher.js';
import { WagerIntegrationEventFactory } from '../../wagering/application/wager-integration-event.factory.js';
import type { WagerProcessingPersistence } from '../../wagering/application/wager-processing.persistence.js';
import { Wallet } from '../domain/wallet.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { LedgerDirection } from '../domain/ledger-direction.js';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: Money;
}

export class CreateWalletUseCase {
  constructor(private readonly persistence: WagerProcessingPersistence) {}

  execute(input: CreateWalletInput): Promise<Wallet> {
    return this.persistence.transactional(async (context) => {
      const wallet = Wallet.open({ id: randomUUID(), ...input });
      await context.wallets.save(wallet);
      if (wallet.balance.isZero()) return wallet;

      const payload = {
        providerId: 'internal:wallet-opening', externalTransactionId: wallet.id,
        walletId: wallet.id, playerId: wallet.playerId, roundId: wallet.id,
        gameId: 'internal:wallet-opening', kind: WagerTransactionKind.Opening,
        money: wallet.balance,
      };
      const transaction = WagerTransaction.create({
        ...payload, id: randomUUID(), idempotencyKey: `internal:wallet-opening:${wallet.id}`,
        payloadHash: new WagerPayloadHasher().hash(payload), createdAt: wallet.createdAt,
      });
      if (!await context.transactions.tryClaim(transaction)) {
        throw new Error('Internal opening claim failed');
      }
      transaction.markProcessed(undefined, wallet.createdAt);
      await context.transactions.saveStateAndResult(transaction, {
        balance: wallet.balance, walletVersion: wallet.version,
      });
      const entry = WalletLedgerEntry.create({
        id: randomUUID(), walletId: wallet.id, transactionId: transaction.id,
        direction: LedgerDirection.Credit, money: wallet.balance,
        balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance,
        createdAt: wallet.createdAt,
      });
      await context.ledger.append(entry);
      for (const event of new WagerIntegrationEventFactory().createForTransition({
        transaction, wallet, previousStatus: WagerTransactionStatus.Pending,
        decidedAt: wallet.createdAt, ledgerEntry: entry,
      })) await context.outbox.append(OutboxMessage.enqueue(event));
      return wallet;
    });
  }
}
