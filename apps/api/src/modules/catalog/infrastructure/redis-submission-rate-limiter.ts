import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '../../../shared/errors';
import { RateLimiter, type RateLimitRule } from '../../../shared/redis';
import { SubmissionRateLimiter } from '../application/ports/submission-rate-limiter';

/** Design §9: 20 submissions per user per 24 hours (fixed window). */
export const SUBMIT_RATE_LIMIT: RateLimitRule = { limit: 20, windowMs: 24 * 60 * 60 * 1000 };

/** Fixed-window Redis counter `rl:catalog:submit:u:{uid}`. */
@Injectable()
export class RedisSubmissionRateLimiter extends SubmissionRateLimiter {
  constructor(private readonly limiter: RateLimiter) {
    super();
  }

  async hitSubmit(userId: string): Promise<void> {
    const result = await this.limiter.hit(`rl:catalog:submit:u:${userId}`, SUBMIT_RATE_LIMIT);
    if (result.limited) {
      throw new RateLimitedError('Too many submissions. Please try again later.', {
        retryAfterMs: result.ttlMs,
      });
    }
  }
}
