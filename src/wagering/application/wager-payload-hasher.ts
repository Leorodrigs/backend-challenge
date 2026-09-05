import { createHash } from 'node:crypto';

import { canonicalizeJson } from './canonical-json.js';
import type { WagerBusinessPayload } from './wager-business-payload.js';

export class WagerPayloadHasher {
  hash(payload: WagerBusinessPayload): string {
    // Explicit allowlist also excludes extra runtime transport/internal fields.
    const { amount, currency } = payload.money.toJSON();
    const canonical = canonicalizeJson({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: { amount, currency },
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}
