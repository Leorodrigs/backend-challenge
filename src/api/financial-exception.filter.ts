import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ExternalTransactionConflictError, IdempotencyConflictError, WalletNotFoundError,
  WalletPlayerMismatchError, UnsupportedWagerTransactionKindError, WagerResultUnavailableError,
  WagerClaimConflictError } from '../wagering/application/errors/wager-processing.errors.js';

function isTransientDependencyError(error: unknown, seen = new Set<object>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);

  const code = 'code' in error ? error.code : undefined;
  const name = 'name' in error ? error.name : undefined;
  const message = 'message' in error ? error.message : undefined;
  if (typeof code === 'string' && /^(08|40|53|57|58|ECONN|ETIMEDOUT|EHOST|ENET)/.test(code)) return true;
  if (typeof name === 'string' && /Connection|Timeout|DriverException/.test(name)) return true;
  if (typeof message === 'string' && (/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)\b/.test(message) ||
    /^Connection terminated(?: unexpectedly)?$/.test(message))) return true;

  if ('cause' in error && isTransientDependencyError(error.cause, seen)) return true;
  if ('errors' in error && Array.isArray(error.errors)) {
    return error.errors.some((nested) => isTransientDependencyError(nested, seen));
  }
  return false;
}

@Catch()
export class FinancialExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FinancialExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    if (error instanceof HttpException) {
      status = error.getStatus(); code = status === 400 ? 'INVALID_REQUEST' : status === 404 ? 'NOT_FOUND' : 'REQUEST_FAILED';
    } else if (error instanceof WalletNotFoundError) { status = 404; code = 'WALLET_NOT_FOUND'; }
    else if (error instanceof WalletPlayerMismatchError || error instanceof UnsupportedWagerTransactionKindError) {
      status = 400; code = 'INVALID_REQUEST';
    } else if (error instanceof IdempotencyConflictError) { status = 409; code = 'IDEMPOTENCY_CONFLICT'; }
    else if (error instanceof ExternalTransactionConflictError) { status = 409; code = 'EXTERNAL_TRANSACTION_CONFLICT'; }
    else if (error instanceof WagerResultUnavailableError || error instanceof WagerClaimConflictError) {
      status = 503; code = 'RESULT_UNAVAILABLE';
    } else if (error !== null && typeof error === 'object') {
      const sqlCode = 'code' in error ? error.code : undefined;
      const constraint = 'constraint' in error ? error.constraint : undefined;
      if (sqlCode === '23505' && constraint === 'wallets_player_currency_unique') {
        status = 409; code = 'WALLET_ALREADY_EXISTS';
      } else if (isTransientDependencyError(error)) {
        status = 503; code = 'DEPENDENCY_UNAVAILABLE';
      }
    }
    if (status >= 500) this.logger.error({ event: 'http_request_failed', code,
      errorType: error instanceof Error ? error.name : 'UnknownError' });
    host.switchToHttp().getResponse<{ status(code: number): { json(value: object): void } }>()
      .status(status).json({ statusCode: status, code });
  }
}
