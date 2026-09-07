import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { CreateWalletUseCase } from '../wallet/application/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction.use-case.js';
import { FinancialQueryPort } from './financial-query.port.js';
import { identifier, parseLedgerQuery, parseWager, parseWallet } from './transport-validation.js';
import { ProviderIdentityGuard } from './provider-identity.guard.js';

@Controller()
@UseGuards(ProviderIdentityGuard)
export class FinancialController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(FinancialQueryPort) private readonly queries: FinancialQueryPort,
  ) {}

  @Post('wallets')
  async open(@Body() body: unknown) {
    const wallet = await this.createWallet.execute(parseWallet(body));
    return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.toJSON(), version: wallet.version,
      createdAt: wallet.createdAt.toISOString(), updatedAt: wallet.updatedAt.toISOString() };
  }

  @Get('wallets/:walletId')
  async wallet(@Param('walletId') id: string) {
    const wallet = await this.queries.wallet(identifier(id));
    if (!wallet) throw new NotFoundException('Wallet not found');
    return wallet;
  }

  @Get('wallets/:walletId/ledger')
  async ledger(@Param('walletId') id: string, @Query() query: unknown) {
    identifier(id);
    const { limit, after } = parseLedgerQuery(query, id);
    if (!await this.queries.wallet(id)) throw new NotFoundException('Wallet not found');
    return this.queries.ledger(id, limit, after);
  }

  @Post('wagering/transactions')
  async submit(@Headers('idempotency-key') key: unknown, @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const result = await this.processWager.execute({ idempotencyKey: identifier(key), payload: parseWager(body) });
    response.status(result.status === 'REJECTED' ? 422 :
      result.status === 'PENDING' || result.status === 'PENDING_REFERENCE' ? 202 :
      result.status === 'FAILED' ? 503 : 200);
    return { ...result, balance: result.balance.toJSON() };
  }

  @Get('wagering/transactions/:transactionId')
  async transaction(@Param('transactionId') id: string) {
    const result = await this.queries.transaction(identifier(id));
    if (!result) throw new NotFoundException('Transaction not found');
    return result;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async external(@Param('providerId') provider: string, @Param('externalTransactionId') external: string) {
    const result = await this.queries.providerTransaction(identifier(provider), identifier(external));
    if (!result) throw new NotFoundException('Transaction not found');
    return result;
  }
}
