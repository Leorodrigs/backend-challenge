import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import {
  applicationConfiguration,
  validateEnvironment,
} from './config/application.config.js';
import { HealthModule } from './health/health.module.js';
import { AwsModule } from './messaging/aws/aws.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { PersistenceModule } from './persistence/mikro-orm/persistence.module.js';
import { WageringModule } from './wagering/wagering.module.js';
import { ReconciliationModule } from './wallet/reconciliation/reconciliation.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      load: [applicationConfiguration],
      validate: validateEnvironment,
    }),
    ObservabilityModule,
    ScheduleModule.forRoot(),
    PersistenceModule,
    AwsModule,
    WageringModule,
    ReconciliationModule,
    HealthModule,
  ],
})
export class AppModule {}
