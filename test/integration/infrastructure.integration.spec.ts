import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  GetQueueAttributesCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import { Pool } from 'pg';

import {
  parseEnvironment,
  type ApplicationConfiguration,
} from '../../src/config/application.config.js';

const shouldRun = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!shouldRun)('bootstrap infrastructure', () => {
  let configuration: ApplicationConfiguration;
  let pool: Pool;
  let sqs: SQSClient;
  let sns: SNSClient;

  beforeAll(async () => {
    configuration = parseEnvironment(process.env);
    const credentials =
      configuration.aws.accessKeyId === undefined ||
      configuration.aws.secretAccessKey === undefined
        ? undefined
        : {
            accessKeyId: configuration.aws.accessKeyId,
            secretAccessKey: configuration.aws.secretAccessKey,
          };

    pool = new Pool({
      host: configuration.database.host,
      port: configuration.database.port,
      database: configuration.database.name,
      user: configuration.database.user,
      password: configuration.database.password,
    });
    sqs = new SQSClient({
      region: configuration.aws.region,
      ...(configuration.aws.endpoint === undefined
        ? {}
        : {
            endpoint: configuration.aws.endpoint,
            useQueueUrlAsEndpoint: false,
          }),
      ...(credentials === undefined ? {} : { credentials }),
    });
    sns = new SNSClient({
      region: configuration.aws.region,
      ...(configuration.aws.endpoint === undefined
        ? {}
        : { endpoint: configuration.aws.endpoint }),
      ...(credentials === undefined ? {} : { credentials }),
    });

    await pool.query('select 1');
  });

  afterAll(async () => {
    await pool.end();
    sqs.destroy();
    sns.destroy();
  });

  test('PostgreSQL accepts a real query', async () => {
    const result = await pool.query<{ value: number }>('select 1 as value');

    expect(result.rows[0]?.value).toBe(1);
  });

  test('LocalStack contains the wager queues and DLQ redrive policy', async () => {
    const queues = await sqs.send(new ListQueuesCommand({}));

    expect(
      queues.QueueUrls?.some((queueUrl) =>
        queueUrl.endsWith('/wager-transactions.fifo'),
      ),
    ).toBe(true);
    expect(
      queues.QueueUrls?.some((queueUrl) =>
        queueUrl.endsWith('/wager-transactions-dlq.fifo'),
      ),
    ).toBe(true);
    expect(
      queues.QueueUrls?.some((queueUrl) =>
        queueUrl.endsWith('/wager-integration-events-audit'),
      ),
    ).toBe(true);

    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: configuration.aws.wagerQueueUrl,
        AttributeNames: ['RedrivePolicy'],
      }),
    );
    const redrivePolicy = attributes.Attributes?.RedrivePolicy;

    expect(redrivePolicy).toBeDefined();
    expect(redrivePolicy).toContain('wager-transactions-dlq.fifo');
    expect(redrivePolicy).toContain('"maxReceiveCount":"5"');
  });

  test('SNS topic has the audit queue subscription', async () => {
    const topics = await sns.send(new ListTopicsCommand({}));
    const topicArn = topics.Topics?.find(
      (topic) =>
        topic.TopicArn === configuration.aws.integrationEventsTopicArn,
    )?.TopicArn;

    expect(topicArn).toBe(configuration.aws.integrationEventsTopicArn);

    const subscriptions = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
    );
    const auditSubscription = subscriptions.Subscriptions?.find(
      (subscription) =>
        subscription.Protocol === 'sqs' &&
        subscription.Endpoint?.endsWith(
          ':wager-integration-events-audit',
        ),
    );

    expect(auditSubscription).toBeDefined();
  });
});
