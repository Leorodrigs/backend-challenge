import { Controller, Get, Res } from '@nestjs/common';

import { ApplicationMetrics } from './application-metrics.js';
import { MetricsCollector } from './metrics.collector.js';

interface MetricsHttpResponse {
  setHeader(name: string, value: string): void;
}

@Controller()
export class MetricsController {
  constructor(
    private readonly collector: MetricsCollector,
    private readonly metrics: ApplicationMetrics,
  ) {}

  @Get('metrics')
  async scrape(
    @Res({ passthrough: true }) response: MetricsHttpResponse,
  ): Promise<string> {
    await this.collector.refresh();
    response.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.metrics();
  }
}
