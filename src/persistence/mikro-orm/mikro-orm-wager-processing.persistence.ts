import { EntityManager, IsolationLevel } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';

import {
  WagerProcessingPersistence,
  type WagerProcessingContext,
} from '../../wagering/application/wager-processing.persistence.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerEntryRepository } from './repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';
import { MikroOrmInboxMessageRepository } from './repositories/mikro-orm-inbox-message.repository.js';

@Injectable()
export class MikroOrmWagerProcessingPersistence extends WagerProcessingPersistence {
  constructor(
    @Inject(EntityManager) private readonly entityManager: PostgreSqlEntityManager,
  ) {
    super();
  }

  override transactional<T>(
    work: (context: WagerProcessingContext) => Promise<T>,
  ): Promise<T> {
    // Each execution owns its identity map, including when called concurrently
    // from the same Nest provider or from an existing request context.
    const isolated = this.entityManager.fork({ clear: true, useContext: false });

    return isolated.transactional(
      (transactionalEntityManager) => work({
        inbox: new MikroOrmInboxMessageRepository(transactionalEntityManager),
        wallets: new MikroOrmWalletRepository(transactionalEntityManager),
        transactions: new MikroOrmWagerTransactionRepository(
          transactionalEntityManager,
        ),
        ledger: new MikroOrmWalletLedgerEntryRepository(
          transactionalEntityManager,
        ),
      }),
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }
}
