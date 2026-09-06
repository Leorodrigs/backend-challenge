import { createHash } from 'node:crypto';

import { canonicalizeJson } from '../../wagering/application/canonical-json.js';
import type { WagerTransactionRequestedEnvelope } from './wager-transaction-requested.parser.js';

export class InboxEnvelopeHasher {
  hash(envelope: WagerTransactionRequestedEnvelope): string {
    const { amount, currency } = envelope.data.money.toJSON();
    const canonicalEnvelope = canonicalizeJson({
      messageId: envelope.messageId,
      type: envelope.type,
      occurredAt: envelope.occurredAt.toISOString(),
      data: {
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        idempotencyKey: envelope.data.idempotencyKey,
        playerId: envelope.data.playerId,
        walletId: envelope.data.walletId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: envelope.data.kind,
        money: { amount, currency },
        referenceExternalTransactionId:
          envelope.data.referenceExternalTransactionId,
      },
    });

    return createHash('sha256')
      .update(canonicalEnvelope, 'utf8')
      .digest('hex');
  }
}
