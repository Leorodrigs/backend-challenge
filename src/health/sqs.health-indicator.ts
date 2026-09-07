import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../config/application.config.js';
import { SQS_CLIENT } from '../messaging/aws/aws.constants.js';

@Injectable()
export class SqsHealthIndicator {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    @Inject(applicationConfiguration.KEY)
    private readonly configuration: ApplicationConfiguration,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('sqs');

    try {
      await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.configuration.aws.wagerQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      return indicator.up();
    } catch {
      return indicator.down({
        message: 'SQS check failed',
      });
    }
  }
}
