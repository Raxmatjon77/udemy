/**
 * Per-user free-enrollment limit (design §9 "Other rate limits": 30 per hour,
 * `rl:enrollment:free:u:{uid}`). Counts one hit and throws `RateLimitedError` (429
 * `rate_limited`, with Retry-After) once the window is exhausted. Fails closed: an unreachable
 * Redis is a 503.
 */
export abstract class FreeEnrollmentRateLimiter {
  abstract hitFreeEnrollment(userId: string): Promise<void>;
}
