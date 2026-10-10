import { DependencyUnavailableError } from '@udemy/nest-common/errors';

/**
 * Redis could not serve a command (down, reconnecting, timed out, or replied with an error).
 * The global filter maps it to `503 service_unavailable`: Redis-backed security checks
 * (revocation, rate limits) fail closed (design D11, confirmed in §13).
 */
export class RedisUnavailableError extends DependencyUnavailableError {
  constructor(options: { cause?: unknown } = {}) {
    super('redis', options);
  }
}

/**
 * Runs Redis commands and turns any failure into `RedisUnavailableError`. Use it around every
 * direct use of the REDIS client on a request path, so an outage becomes a 503 and never a
 * 500 or, worse, a silently skipped check.
 *
 *   const revoked = await withRedis(() => this.redis.exists(`auth:revoked:sid:${sid}`));
 */
export async function withRedis<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RedisUnavailableError) throw error;
    throw new RedisUnavailableError({ cause: error });
  }
}
