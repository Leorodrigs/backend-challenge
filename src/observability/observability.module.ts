import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { AwsModule } from '../messaging/aws/aws.module.js';
import { PersistenceModule } from '../persistence/mikro-orm/persistence.module.js';
import { ApplicationMetrics } from './application-metrics.js';
import { MetricsCollector } from './metrics.collector.js';
import { MetricsController } from './metrics.controller.js';

@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: 'info',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["idempotency-key"]',
            'req.body',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
    PersistenceModule,
    AwsModule,
  ],
  controllers: [MetricsController],
  providers: [ApplicationMetrics, MetricsCollector],
  exports: [LoggerModule, ApplicationMetrics],
})
export class ObservabilityModule {}
