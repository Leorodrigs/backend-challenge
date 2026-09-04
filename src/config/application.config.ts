import { registerAs } from '@nestjs/config';

const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export interface ApplicationConfiguration {
  app: {
    environment: NodeEnvironment;
    port: number;
  };
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  aws: {
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    wagerQueueUrl: string;
    wagerDlqUrl: string;
    sqsWaitTimeSeconds: number;
    sqsVisibilityTimeout: number;
    integrationEventsTopicArn: string;
  };
  workers: {
    referenceRetryBaseMs: number;
    referenceRetryMaxMs: number;
    referenceTtlMs: number;
    outboxBatchSize: number;
    outboxPollIntervalMs: number;
  };
}

function requiredString(
  environment: Record<string, unknown>,
  name: string,
): string {
  const value = environment[name];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Environment variable ${name} is required`);
  }

  return value.trim();
}

function optionalString(
  environment: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = environment[name];

  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Environment variable ${name} must be a non-empty string`);
  }

  return value.trim();
}

function integerInRange(
  environment: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const rawValue = requiredString(environment, name);

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Environment variable ${name} must be between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

function validUrl(value: string, name: string): string {
  try {
    const parsed = new URL(value);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(`Environment variable ${name} must be a valid HTTP URL`);
  }

  return value;
}

function nodeEnvironment(
  environment: Record<string, unknown>,
): NodeEnvironment {
  const value = requiredString(environment, 'NODE_ENV');

  if (
    value === 'development' ||
    value === 'test' ||
    value === 'production'
  ) {
    return value;
  }

  throw new Error(
    `Environment variable NODE_ENV must be one of: ${NODE_ENVIRONMENTS.join(', ')}`,
  );
}

export function parseEnvironment(
  environment: Record<string, unknown>,
): ApplicationConfiguration {
  const endpointValue = optionalString(environment, 'AWS_ENDPOINT_URL');
  const accessKeyId = optionalString(environment, 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = optionalString(environment, 'AWS_SECRET_ACCESS_KEY');

  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new Error(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be provided together',
    );
  }

  if (
    endpointValue !== undefined &&
    (accessKeyId === undefined || secretAccessKey === undefined)
  ) {
    throw new Error(
      'AWS credentials are required when AWS_ENDPOINT_URL is configured',
    );
  }

  const referenceRetryBaseMs = integerInRange(
    environment,
    'REFERENCE_RETRY_BASE_MS',
    1,
    86_400_000,
  );
  const referenceRetryMaxMs = integerInRange(
    environment,
    'REFERENCE_RETRY_MAX_MS',
    1,
    86_400_000,
  );

  if (referenceRetryBaseMs > referenceRetryMaxMs) {
    throw new Error(
      'REFERENCE_RETRY_BASE_MS must not exceed REFERENCE_RETRY_MAX_MS',
    );
  }

  const endpoint =
    endpointValue === undefined
      ? undefined
      : validUrl(endpointValue, 'AWS_ENDPOINT_URL');

  return {
    app: {
      environment: nodeEnvironment(environment),
      port: integerInRange(environment, 'PORT', 1, 65_535),
    },
    database: {
      host: requiredString(environment, 'DATABASE_HOST'),
      port: integerInRange(environment, 'DATABASE_PORT', 1, 65_535),
      name: requiredString(environment, 'DATABASE_NAME'),
      user: requiredString(environment, 'DATABASE_USER'),
      password: requiredString(environment, 'DATABASE_PASSWORD'),
    },
    aws: {
      region: requiredString(environment, 'AWS_REGION'),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(accessKeyId === undefined ? {} : { accessKeyId }),
      ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
      wagerQueueUrl: validUrl(
        requiredString(environment, 'WAGER_QUEUE_URL'),
        'WAGER_QUEUE_URL',
      ),
      wagerDlqUrl: validUrl(
        requiredString(environment, 'WAGER_DLQ_URL'),
        'WAGER_DLQ_URL',
      ),
      sqsWaitTimeSeconds: integerInRange(
        environment,
        'SQS_WAIT_TIME_SECONDS',
        0,
        20,
      ),
      sqsVisibilityTimeout: integerInRange(
        environment,
        'SQS_VISIBILITY_TIMEOUT',
        1,
        43_200,
      ),
      integrationEventsTopicArn: requiredString(
        environment,
        'INTEGRATION_EVENTS_TOPIC_ARN',
      ),
    },
    workers: {
      referenceRetryBaseMs,
      referenceRetryMaxMs,
      referenceTtlMs: integerInRange(
        environment,
        'REFERENCE_TTL_MS',
        1,
        2_147_483_647,
      ),
      outboxBatchSize: integerInRange(
        environment,
        'OUTBOX_BATCH_SIZE',
        1,
        10_000,
      ),
      outboxPollIntervalMs: integerInRange(
        environment,
        'OUTBOX_POLL_INTERVAL_MS',
        1,
        86_400_000,
      ),
    },
  };
}

export function validateEnvironment(
  environment: Record<string, unknown>,
): Record<string, unknown> {
  parseEnvironment(environment);
  return environment;
}

export function loadApplicationConfiguration(): ApplicationConfiguration {
  return parseEnvironment(process.env);
}

export const applicationConfiguration = registerAs(
  'application',
  loadApplicationConfiguration,
);
