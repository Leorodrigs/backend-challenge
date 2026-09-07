import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { PendingReferenceWorker } from './application/pending-reference.worker.js';

@Injectable()
export class PendingReferenceScheduler {
  private readonly logger = new Logger(PendingReferenceScheduler.name);
  private stopping = false;
  private active: Promise<unknown> | undefined;

  constructor(@Inject(PendingReferenceWorker) private readonly worker: PendingReferenceWorker) {}

  @Interval(1_000)
  async tick(): Promise<void> {
    if (this.stopping || this.active !== undefined) return;
    try {
      this.active = this.worker.runOnce();
      await this.active;
    } catch {
      // The failed SQL transaction is rolled back and remains eligible on the next tick.
      this.logger.error('Pending reference iteration failed; PostgreSQL work remains eligible');
    } finally {
      this.active = undefined;
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.active?.catch(() => undefined);
  }
}
