import {
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import type { MoneyProps } from '../../shared/domain/value-objects/money.js';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case.js';
import {
  LedgerCurrencyIntegrityError,
  ReconciliationWalletNotFoundError,
} from './wallet-reconciliation.errors.js';

interface WalletReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Controller('wallets')
export class ReconciliationController {
  constructor(private readonly reconcileWallet: ReconcileWalletUseCase) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<WalletReconciliationResponse> {
    try {
      const result = await this.reconcileWallet.execute(walletId);
      return {
        walletId: result.walletId,
        storedBalance: result.storedBalance.toJSON(),
        calculatedBalance: result.calculatedBalance.toJSON(),
        difference: result.difference.toJSON(),
        consistent: result.consistent,
        checkedEntries: result.checkedEntries,
      };
    } catch (error: unknown) {
      if (error instanceof ReconciliationWalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof LedgerCurrencyIntegrityError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}
