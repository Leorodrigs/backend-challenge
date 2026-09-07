import { describe, expect, mock, test } from 'bun:test';
import { PendingReferenceScheduler } from '../../../../src/wagering/pending-reference.scheduler.js';
import type { PendingReferenceWorker } from '../../../../src/wagering/application/pending-reference.worker.js';

describe('pending reference scheduler shutdown', () => {
  test('waits for active SQL work and prevents another tick after shutdown starts', async () => {
    const gate = Promise.withResolvers<[]>();
    const runOnce = mock(() => gate.promise);
    const scheduler = new PendingReferenceScheduler({ runOnce } as unknown as PendingReferenceWorker);
    const tick = scheduler.tick();
    let drained = false;
    const shutdown = scheduler.beforeApplicationShutdown().then(() => { drained = true; });
    await scheduler.tick(); expect(runOnce).toHaveBeenCalledTimes(1); expect(drained).toBe(false);
    gate.resolve([]); await Promise.all([tick, shutdown]);
    await scheduler.tick(); expect(drained).toBe(true); expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
