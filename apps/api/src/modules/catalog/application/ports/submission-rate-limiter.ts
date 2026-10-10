/**
 * Per-user submit limit (design §9: `rl:catalog:submit:u:{uid}`, 20 per 24 h). Counts one hit
 * and throws `RateLimitedError` (429 `rate_limited`, with Retry-After) once the window is
 * exhausted. Fails closed: an unreachable Redis is a 503.
 */
export abstract class SubmissionRateLimiter {
  abstract hitSubmit(userId: string): Promise<void>;
}
