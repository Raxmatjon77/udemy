import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '../../../shared/errors';
import { RateLimiter } from '../../../shared/redis';
import {
  ENGAGEMENT_API_RATE_LIMITS,
  EngagementRateLimiter,
  type EngagementRateLimitName,
} from '../application/ports/engagement-rate-limiter';

/** The Redis counter of one rule and subject (design §6 `rl:eng:*`; tests clear it). */
export function engagementRateLimitKey(rule: EngagementRateLimitName, subject: string): string {
  const scope = ENGAGEMENT_API_RATE_LIMITS[rule].per === 'ip' ? 'ip' : 'u';
  return `rl:eng:${rule}:${scope}:${subject}`;
}

/** Fixed-window Redis counters `rl:eng:{rule}:{u|ip}:{subject}`; fail closed (503). */
@Injectable()
export class RedisEngagementRateLimiter extends EngagementRateLimiter {
  constructor(private readonly limiter: RateLimiter) {
    super();
  }

  async hit(rule: EngagementRateLimitName, subject: string): Promise<void> {
    const { limit, windowSeconds } = ENGAGEMENT_API_RATE_LIMITS[rule];
    const result = await this.limiter.hit(engagementRateLimitKey(rule, subject), {
      limit,
      windowMs: windowSeconds * 1000,
    });
    if (result.limited) {
      throw new RateLimitedError('Too many requests. Please try again later.', {
        retryAfterMs: result.ttlMs,
      });
    }
  }
}
