import { Global, Module } from '@nestjs/common';
import { SNSClient, type SNSClientConfig } from '@aws-sdk/client-sns';
import { SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs';

import {
  applicationConfiguration,
  type ApplicationConfiguration,
} from '../../config/application.config.js';
import { AwsClientsLifecycle } from './aws-clients.lifecycle.js';
import { SNS_CLIENT, SQS_CLIENT } from './aws.constants.js';

function sharedClientConfiguration(
  configuration: ApplicationConfiguration,
): SNSClientConfig {
  return {
    region: configuration.aws.region,
    ...(configuration.aws.endpoint === undefined
      ? {}
      : { endpoint: configuration.aws.endpoint }),
    ...(configuration.aws.accessKeyId === undefined ||
    configuration.aws.secretAccessKey === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: configuration.aws.accessKeyId,
            secretAccessKey: configuration.aws.secretAccessKey,
          },
        }),
  };
}

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [applicationConfiguration.KEY],
      useFactory: (configuration: ApplicationConfiguration): SQSClient => {
        const clientConfiguration: SQSClientConfig = {
          ...sharedClientConfiguration(configuration),
          ...(configuration.aws.endpoint === undefined
            ? {}
            : { useQueueUrlAsEndpoint: false }),
        };

        return new SQSClient(clientConfiguration);
      },
    },
    {
      provide: SNS_CLIENT,
      inject: [applicationConfiguration.KEY],
      useFactory: (configuration: ApplicationConfiguration): SNSClient =>
        new SNSClient(sharedClientConfiguration(configuration)),
    },
    AwsClientsLifecycle,
  ],
  exports: [SQS_CLIENT, SNS_CLIENT],
})
export class AwsModule {}
