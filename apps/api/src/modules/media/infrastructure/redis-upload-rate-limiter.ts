import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '../../../shared/errors';
import { RateLimiter, type RateLimitRule } from '../../../shared/redis';
import { MEDIA_RATE_LIMITS } from '../application/media-settings';
import { UploadRateLimiter } from '../application/ports/upload-rate-limiter';

/** Fixed-window Redis counters (design §9): `rl:media:initiate:u:{uid}`, `rl:media:parts:u:{uid}`. */
@Injectable()
export class RedisUploadRateLimiter extends UploadRateLimiter {
  constructor(private readonly limiter: RateLimiter) {
    super();
  }

  hitInitiate(userId: string): Promise<void> {
    return this.hit(`rl:media:initiate:u:${userId}`, MEDIA_RATE_LIMITS.initiate);
  }

  hitPresignParts(userId: string): Promise<void> {
    return this.hit(`rl:media:parts:u:${userId}`, MEDIA_RATE_LIMITS.presignParts);
  }

  private async hit(key: string, rule: RateLimitRule): Promise<void> {
    const result = await this.limiter.hit(key, rule);
    if (result.limited) {
      throw new RateLimitedError('Too many requests. Please try again later.', {
        retryAfterMs: result.ttlMs,
      });
    }
  }
}
