import { LEARNING_RATE_LIMITS } from '@udemy/contracts';

/** The learning rules this module enforces (design §9, contracts `LEARNING_RATE_LIMITS`). */
export type LearningRateLimitName = keyof typeof LEARNING_RATE_LIMITS;

/**
 * Counts one hit of `rule` for `subject` (a user id, or the end-user IP for `per: 'ip'`) and
 * throws `RateLimitedError` (429 `rate_limited`, with Retry-After) once the window is exhausted.
 * Fails closed: an unreachable Redis is a 503.
 */
export abstract class LearningRateLimiter {
  abstract hit(rule: LearningRateLimitName, subject: string): Promise<void>;
}
