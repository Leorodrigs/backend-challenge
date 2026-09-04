import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller.js';
import { LivenessHealthIndicator } from './liveness.health-indicator.js';
import { PostgresHealthIndicator } from './postgres.health-indicator.js';
import { SqsHealthIndicator } from './sqs.health-indicator.js';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    LivenessHealthIndicator,
    PostgresHealthIndicator,
    SqsHealthIndicator,
  ],
})
export class HealthModule {}
