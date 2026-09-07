import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../config/application.config.js';
import { SQS_CLIENT } from '../messaging/aws/aws.constants.js';
import { ApplicationMetrics } from './application-metrics.js';
import { MetricsStatePersistence } from './metrics-state.persistence.js';

@Injectable()
export class MetricsCollector {
  constructor(
    private readonly persistence: MetricsStatePersistence,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    @Inject(applicationConfiguration.KEY)
    private readonly configuration: ApplicationConfiguration,
    private readonly metrics: ApplicationMetrics,
  ) {}

  async refresh(): Promise<void> {
    const persisted = await this.persistence.collect();
    const response = await this.sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.configuration.aws.wagerDlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    const rawVisible = response.Attributes?.ApproximateNumberOfMessages;
    if (rawVisible === undefined || !/^\d+$/.test(rawVisible)) {
      throw new Error('SQS omitted the visible DLQ message count');
    }
    const dlqMessagesVisible = Number(rawVisible);
    if (!Number.isSafeInteger(dlqMessagesVisible)) {
      throw new Error('Visible DLQ count exceeds JavaScript safe integer range');
    }

    this.metrics.updateObservableState({
      ...persisted,
      dlqMessagesVisible,
    });
  }
}
