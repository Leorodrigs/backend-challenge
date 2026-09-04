import { describe, expect, test } from 'bun:test';

import { LivenessHealthIndicator } from '../../../src/health/liveness.health-indicator.js';

describe('LivenessHealthIndicator', () => {
  test('reports the running process as up without checking dependencies', () => {
    const indicator = new LivenessHealthIndicator();

    expect(indicator.check()).toEqual({
      application: {
        status: 'up',
      },
    });
  });
});
