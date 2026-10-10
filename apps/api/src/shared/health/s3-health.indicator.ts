import { Inject, Injectable, Logger } from '@nestjs/common';
import { type HealthIndicatorResult, indicatorResult } from '@udemy/nest-common';
import { ObjectStorage } from '@udemy/storage';

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Readiness check: do both buckets answer `HeadBucket` in time (`ObjectStorage.ping`)?
 * Uploads, playlists and signed URLs all need S3, so a pod without it must not get traffic.
 * Usage with terminus: `this.health.check([() => this.s3.check('s3')])`.
 */
@Injectable()
export class S3HealthIndicator {
  private readonly logger = new Logger(S3HealthIndicator.name);

  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {}

  async check<TKey extends string>(
    key: TKey,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<HealthIndicatorResult<TKey>> {
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.storage.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return indicatorResult(key, 'up', {
        responseTimeMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      // Bucket names and the cause go to the log only; the public response stays generic.
      this.logger.warn({ err: error }, 'Object storage health check failed');
      return indicatorResult(key, 'down', { message: 'Object storage is unreachable' });
    } finally {
      clearTimeout(timer);
    }
  }
}
