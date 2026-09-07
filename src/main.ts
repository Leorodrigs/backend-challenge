import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from './config/application.config.js';

async function bootstrap(): Promise<void> {
  // nestjs-pino is CommonJS and requires Nest's ESM core synchronously. Load
  // the core to completion first so Bun never observes it mid-evaluation.
  const { NestFactory } = await import('@nestjs/core');
  const { Logger } = await import('nestjs-pino');
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const configuration = app.get<ApplicationConfiguration>(
    applicationConfiguration.KEY,
  );

  app.useLogger(app.get(Logger));
  app.flushLogs();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  await app.listen(configuration.app.port, '0.0.0.0');
}

await bootstrap();
