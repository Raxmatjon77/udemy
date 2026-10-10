import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, indicatorResult } from '@udemy/nest-common';
import { ObjectStorage } from '@udemy/storage';

/** Bound on a readiness probe so a stalled MinIO cannot hang /health/ready. */
export const S3_PROBE_TIMEOUT_MS = 3_000;

/** HeadBucket on both buckets (`ObjectStorage.ping`), used by MediaCleanupJob. */
@Injectable()
export class S3HealthIndicator {
  constructor(private readonly storage: ObjectStorage) {}

  async check<TKey extends string>(key: TKey): Promise<HealthIndicatorResult<TKey>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.storage.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer within ${S3_PROBE_TIMEOUT_MS} ms`)),
            S3_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return indicatorResult(key, 'up');
    } catch (error) {
      // Only the error name/message: never echo endpoints or credentials into the probe body.
      const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unavailable';
      return indicatorResult(key, 'down', { message });
    } finally {
      clearTimeout(timer);
    }
  }
}
