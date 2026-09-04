import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
} from '@nestjs/terminus';

import { LivenessHealthIndicator } from './liveness.health-indicator.js';
import { PostgresHealthIndicator } from './postgres.health-indicator.js';
import { SqsHealthIndicator } from './sqs.health-indicator.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly liveness: LivenessHealthIndicator,
    private readonly postgres: PostgresHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.healthCheckService.check([() => this.liveness.check()]);
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.healthCheckService.check([
      () => this.postgres.check(),
      () => this.sqs.check(),
    ]);
  }
}
