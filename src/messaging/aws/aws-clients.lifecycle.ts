import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { SQSClient } from '@aws-sdk/client-sqs';

import { SNS_CLIENT, SQS_CLIENT } from './aws.constants.js';

@Injectable()
export class AwsClientsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    @Inject(SNS_CLIENT) private readonly snsClient: SNSClient,
  ) {}

  onApplicationShutdown(): void {
    this.sqsClient.destroy();
    this.snsClient.destroy();
  }
}
