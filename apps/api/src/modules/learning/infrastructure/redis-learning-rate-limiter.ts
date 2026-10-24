import { Injectable } from '@nestjs/common';
import { LEARNING_RATE_LIMITS } from '@udemy/contracts';
import { RateLimitedError } from '../../../shared/errors';
import { RateLimiter } from '../../../shared/redis';
import {
  LearningRateLimiter,
  type LearningRateLimitName,
} from '../application/ports/learning-rate-limiter';

/** The Redis counter of one rule and subject (design §6 `rl:lrn:*`; tests clear it). */
export function learningRateLimitKey(rule: LearningRateLimitName, subject: string): string {
  const scope = LEARNING_RATE_LIMITS[rule].per === 'ip' ? 'ip' : 'u';
  return `rl:lrn:${rule}:${scope}:${subject}`;
}

/** Fixed-window Redis counters `rl:lrn:{rule}:{u|ip}:{subject}`; fail closed (503). */
@Injectable()
export class RedisLearningRateLimiter extends LearningRateLimiter {
  constructor(private readonly limiter: RateLimiter) {
    super();
  }

  async hit(rule: LearningRateLimitName, subject: string): Promise<void> {
    const { limit, windowSeconds } = LEARNING_RATE_LIMITS[rule];
    const result = await this.limiter.hit(learningRateLimitKey(rule, subject), {
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
