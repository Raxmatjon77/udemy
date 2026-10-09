import type { Provider } from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';
import type { RetryPolicy } from './retry-with-backoff';

export const RETRY_POLICY = Symbol('RETRY_POLICY');

export const retryPolicyProvider: Provider = {
  provide: RETRY_POLICY,
  inject: [WorkerConfigService],
  useFactory: (config: WorkerConfigService): RetryPolicy => ({
    maxRetries: config.get('WORKER_MAX_RETRIES'),
    baseDelayMs: config.get('WORKER_RETRY_BASE_DELAY_MS'),
    maxDelayMs: config.get('WORKER_RETRY_MAX_DELAY_MS'),
  }),
};
