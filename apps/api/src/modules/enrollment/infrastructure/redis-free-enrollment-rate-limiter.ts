import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '../../../shared/errors';
import { RateLimiter, type RateLimitRule } from '../../../shared/redis';
import { FreeEnrollmentRateLimiter } from '../application/ports/free-enrollment-rate-limiter';

/** Design §9: 30 free enrollments per user per hour (fixed window). */
export const FREE_ENROLLMENT_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 60 * 1000 };

/** The Redis counter of one user (tests clear it). */
export function freeEnrollmentRateLimitKey(userId: string): string {
  return `rl:enrollment:free:u:${userId}`;
}

/** Fixed-window Redis counter `rl:enrollment:free:u:{uid}`; fails closed (503). */
@Injectable()
export class RedisFreeEnrollmentRateLimiter extends FreeEnrollmentRateLimiter {
  constructor(private readonly limiter: RateLimiter) {
    super();
  }

  async hitFreeEnrollment(userId: string): Promise<void> {
    const result = await this.limiter.hit(
      freeEnrollmentRateLimitKey(userId),
      FREE_ENROLLMENT_RATE_LIMIT,
    );
    if (result.limited) {
      throw new RateLimitedError('Too many enrollments. Please try again later.', {
        retryAfterMs: result.ttlMs,
      });
    }
  }
}
