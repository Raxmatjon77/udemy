import { ENGAGEMENT_RATE_LIMITS, type RateLimitRule } from '@udemy/contracts';

/**
 * Engagement rate limits (design §9, contracts `ENGAGEMENT_RATE_LIMITS`), plus `reviewReply`,
 * which the contracts do not list: instructors answer many reviews, so the student review
 * limit (20 per 24 h) would be too tight; 100 per 24 h per instructor matches the answer limit.
 */
export const ENGAGEMENT_API_RATE_LIMITS = Object.freeze({
  ...ENGAGEMENT_RATE_LIMITS,
  reviewReply: { limit: 100, windowSeconds: 86_400, per: 'instructor' },
} as const satisfies Record<string, RateLimitRule>);

export type EngagementRateLimitName = keyof typeof ENGAGEMENT_API_RATE_LIMITS;

/**
 * Counts one hit of `rule` for `subject` (a user id, or the end-user IP for `per: 'ip'`) and
 * throws `RateLimitedError` (429 `rate_limited`, with Retry-After) once the window is
 * exhausted. Fails closed: an unreachable Redis is a 503.
 */
export abstract class EngagementRateLimiter {
  abstract hit(rule: EngagementRateLimitName, subject: string): Promise<void>;
}
