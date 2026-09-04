import { describe, expect, test } from 'bun:test';

import { parseEnvironment } from '../../../src/config/application.config.js';

const validEnvironment: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'wagering',
  DATABASE_USER: 'wagering',
  DATABASE_PASSWORD: 'wagering',
  AWS_REGION: 'us-east-1',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  WAGER_QUEUE_URL:
    'http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo',
  WAGER_DLQ_URL:
    'http://localhost:4566/queue/us-east-1/000000000000/wager-transactions-dlq.fifo',
  SQS_WAIT_TIME_SECONDS: '20',
  SQS_VISIBILITY_TIMEOUT: '30',
  INTEGRATION_EVENTS_TOPIC_ARN:
    'arn:aws:sns:us-east-1:000000000000:wager-integration-events',
  REFERENCE_RETRY_BASE_MS: '1000',
  REFERENCE_RETRY_MAX_MS: '60000',
  REFERENCE_TTL_MS: '86400000',
  OUTBOX_BATCH_SIZE: '100',
  OUTBOX_POLL_INTERVAL_MS: '1000',
};

describe('application configuration', () => {
  test('parses and types a valid environment', () => {
    const configuration = parseEnvironment(validEnvironment);

    expect(configuration.app).toEqual({
      environment: 'test',
      port: 3000,
    });
    expect(configuration.database.port).toBe(5432);
    expect(configuration.aws.sqsWaitTimeSeconds).toBe(20);
    expect(configuration.workers.outboxBatchSize).toBe(100);
  });

  test('fails fast when a required variable is absent', () => {
    const environment = { ...validEnvironment };
    delete environment.DATABASE_HOST;

    expect(() => parseEnvironment(environment)).toThrow(
      'Environment variable DATABASE_HOST is required',
    );
  });

  test('rejects an invalid SQS long-poll duration', () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        SQS_WAIT_TIME_SECONDS: '21',
      }),
    ).toThrow(
      'Environment variable SQS_WAIT_TIME_SECONDS must be between 0 and 20',
    );
  });

  test('allows the AWS default credential chain without a local endpoint', () => {
    const environment = { ...validEnvironment };
    delete environment.AWS_ENDPOINT_URL;
    delete environment.AWS_ACCESS_KEY_ID;
    delete environment.AWS_SECRET_ACCESS_KEY;

    const configuration = parseEnvironment(environment);

    expect(configuration.aws.endpoint).toBeUndefined();
    expect(configuration.aws.accessKeyId).toBeUndefined();
  });

});
