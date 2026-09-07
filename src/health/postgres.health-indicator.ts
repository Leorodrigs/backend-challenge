import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { MikroORM } from '@mikro-orm/core';
import type { HealthIndicatorResult } from '@nestjs/terminus';

@Injectable()
export class PostgresHealthIndicator {
  constructor(
    private readonly orm: MikroORM,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('postgres');

    try {
      await this.orm.em.getConnection().execute('select 1');
      return indicator.up();
    } catch {
      return indicator.down({
        message:
          'PostgreSQL check failed',
      });
    }
  }
}
