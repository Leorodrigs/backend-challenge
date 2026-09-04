import { Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';

@Injectable()
export class LivenessHealthIndicator {
  check(): HealthIndicatorResult {
    return {
      application: {
        status: 'up',
      },
    };
  }
}
