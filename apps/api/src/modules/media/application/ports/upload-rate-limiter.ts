/**
 * Per-user upload rate limits (design §9). Each call counts one hit and throws
 * `RateLimitedError` (429 `rate_limited`, with Retry-After) once the window is exhausted.
 * Fails closed: an unreachable Redis is a 503.
 */
export abstract class UploadRateLimiter {
  abstract hitInitiate(userId: string): Promise<void>;
  abstract hitPresignParts(userId: string): Promise<void>;
}
