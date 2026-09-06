import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from '../../shared/domain/errors/money.errors.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  UnsupportedWagerTransactionKindError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
  WagerResultUnavailableError,
} from '../../wagering/application/errors/wager-processing.errors.js';
import {
  InvalidRollbackReferenceError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  MissingTransactionReferenceError,
  TransactionHasNoLedgerDirectionError,
} from '../../wagering/domain/errors/wager-transaction.errors.js';
import {
  InvalidWalletAmountError,
  InvalidWalletBalanceError,
  InvalidWalletDateError,
  InvalidWalletIdentifierError,
  InvalidWalletVersionError,
} from '../../wallet/domain/errors/wallet.errors.js';
import { InvalidLedgerEntryError } from '../../wallet/domain/errors/wallet-ledger-entry.errors.js';
import {
  InboxMessageAlreadyProcessedError,
  InboxPayloadConflictError,
  InvalidInboxMessageError,
} from '../inbox/errors/inbox-message.errors.js';
import { InvalidWagerTransactionMessageError } from './errors/wager-message.errors.js';

export enum MessageFailureAction {
  TerminalAck = 'TERMINAL_ACK',
  Retry = 'RETRY',
  Dlq = 'DLQ',
}

export class MessageFailureClassifier {
  classify(error: unknown): MessageFailureAction {
    if (
      error instanceof IdempotencyConflictError ||
      error instanceof ExternalTransactionConflictError
    ) {
      return MessageFailureAction.TerminalAck;
    }

    if (
      error instanceof InvalidWagerTransactionMessageError ||
      error instanceof InboxPayloadConflictError ||
      error instanceof InvalidInboxMessageError ||
      error instanceof InboxMessageAlreadyProcessedError ||
      error instanceof UnsupportedWagerTransactionKindError ||
      error instanceof WalletNotFoundError ||
      error instanceof WalletPlayerMismatchError ||
      error instanceof WagerResultUnavailableError ||
      error instanceof InvalidMoneyAmountError ||
      error instanceof InvalidCurrencyError ||
      error instanceof CurrencyMismatchError ||
      error instanceof InvalidWagerTransactionError ||
      error instanceof MissingTransactionReferenceError ||
      error instanceof InvalidTransactionStateError ||
      error instanceof InvalidRollbackReferenceError ||
      error instanceof TransactionHasNoLedgerDirectionError ||
      error instanceof InvalidWalletIdentifierError ||
      error instanceof InvalidWalletBalanceError ||
      error instanceof InvalidWalletAmountError ||
      error instanceof InvalidWalletVersionError ||
      error instanceof InvalidWalletDateError ||
      error instanceof InvalidLedgerEntryError
    ) {
      return MessageFailureAction.Dlq;
    }

    // Unknown failures include database/network outages, resets, timeouts and
    // deadlocks. At-least-once processing is safer when these retry.
    return MessageFailureAction.Retry;
  }
}
