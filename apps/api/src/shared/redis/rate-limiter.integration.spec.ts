import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useIntegrationRedis } from '../../testing/integration';
import { RateLimiter } from './rate-limiter';

/**
 * Runs the real Lua scripts against the integration Redis (IT_REDIS_URL, default: the dev
 * compose port 56379; see src/testing/integration.ts: skipped locally when unreachable, a
 * failure with CI=true).
 */
describe('RateLimiter (integration, real Redis)', () => {
  const itRedis = useIntegrationRedis();
  let redis: Redis;
  let limiter: RateLimiter;
  const prefix = `test:rl:${randomUUID()}`;

  beforeAll(() => {
    if (!itRedis.available) return;
    redis = itRedis.redis;
    limiter = new RateLimiter(redis);
  });

  afterAll(async () => {
    if (!itRedis.available) return;
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  it('counts atomically under concurrency and sets the TTL once', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const key = `${prefix}:concurrent`;

    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.hit(key, { limit: 20, windowMs: 10_000 })),
    );

    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(results.filter((r) => r.limited)).toHaveLength(5);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(9_000);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  it('does not extend the window on later hits', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const key = `${prefix}:window`;

    await limiter.hit(key, { limit: 5, windowMs: 400 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await limiter.hit(key, { limit: 5, windowMs: 400 });
    expect(second.ttlMs).toBeLessThanOrEqual(260);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await limiter.hit(key, { limit: 5, windowMs: 400 })).count).toBe(1);
  });

  it('repairs a counter that lost its TTL', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const key = `${prefix}:no-ttl`;
    await redis.set(key, '7');

    const result = await limiter.hit(key, { limit: 5, windowMs: 5_000 });

    expect(result).toMatchObject({ count: 8, limited: true });
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });

  it('peeks and resets', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const key = `${prefix}:peek`;

    expect(await limiter.peek(key, { limit: 2 })).toEqual({ count: 0, ttlMs: 0, limited: false });
    await limiter.hit(key, { limit: 2, windowMs: 5_000 });
    await limiter.hit(key, { limit: 2, windowMs: 5_000 });
    expect(await limiter.peek(key, { limit: 2 })).toMatchObject({ count: 2, limited: true });

    await limiter.reset(key);
    expect((await limiter.peek(key, { limit: 2 })).count).toBe(0);
  });

  it('recovers from an empty script cache (EVALSHA -> NOSCRIPT -> EVAL)', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    // SCRIPT FLUSH is safe on the dev Redis: callers reload scripts on NOSCRIPT, as this does.
    await redis.script('FLUSH');

    expect((await limiter.hit(`${prefix}:flush`, { limit: 1, windowMs: 5_000 })).count).toBe(1);
  });
});
