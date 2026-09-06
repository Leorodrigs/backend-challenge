import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { ApplicationConfiguration } from '../../src/config/application.config.js';

export interface DisposableSqsQueues {
  sourceUrl: string;
  dlqUrl: string;
  close(): Promise<void>;
}

export function createSqsClient(
  configuration: ApplicationConfiguration,
): SQSClient {
  return new SQSClient({
    region: configuration.aws.region,
    ...(configuration.aws.endpoint === undefined
      ? {}
      : {
          endpoint: configuration.aws.endpoint,
          useQueueUrlAsEndpoint: false,
        }),
    ...(configuration.aws.accessKeyId === undefined ||
    configuration.aws.secretAccessKey === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: configuration.aws.accessKeyId,
            secretAccessKey: configuration.aws.secretAccessKey,
          },
        }),
  });
}

export async function createDisposableSqsQueues(
  client: SQSClient,
): Promise<DisposableSqsQueues> {
  const suffix = randomUUID().replaceAll('-', '');
  const dlqName = `wager-stage7-${suffix}-dlq.fifo`;
  const sourceName = `wager-stage7-${suffix}.fifo`;
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );
  if (dlq.QueueUrl === undefined) throw new Error('LocalStack omitted DLQ URL');

  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = attributes.Attributes?.QueueArn;
  if (dlqArn === undefined) throw new Error('LocalStack omitted DLQ ARN');

  const source = await client.send(
    new CreateQueueCommand({
      QueueName: sourceName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '10',
        }),
      },
    }),
  );
  if (source.QueueUrl === undefined) {
    await client.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }));
    throw new Error('LocalStack omitted source queue URL');
  }

  let closed = false;
  return {
    sourceUrl: source.QueueUrl,
    dlqUrl: dlq.QueueUrl,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await client.send(new DeleteQueueCommand({ QueueUrl: source.QueueUrl }));
      await client.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }));
    },
  };
}
