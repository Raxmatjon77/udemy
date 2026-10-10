import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter';

/**
 * Runs the real Lua scripts against the dev Redis (REDIS_URL, default: the compose port
 * 56379). Every test skips cleanly when Redis is unreachable.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:56379';

describe('RateLimiter (integration, real Redis)', () => {
  let redis: Redis;
  let limiter: RateLimiter;
  let reachable = false;
  const prefix = `test:rl:${randomUUID()}`;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      reachable = (await redis.ping()) === 'PONG';
    } catch {
      reachable = false;
    }
    limiter = new RateLimiter(redis);
  });

  afterAll(async () => {
    if (reachable) {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    } else {
      redis.disconnect();
    }
  });

  it('counts atomically under concurrency and sets the TTL once', async (ctx) => {
    if (!reachable) ctx.skip();
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
    if (!reachable) ctx.skip();
    const key = `${prefix}:window`;

    await limiter.hit(key, { limit: 5, windowMs: 400 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await limiter.hit(key, { limit: 5, windowMs: 400 });
    expect(second.ttlMs).toBeLessThanOrEqual(260);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await limiter.hit(key, { limit: 5, windowMs: 400 })).count).toBe(1);
  });

  it('repairs a counter that lost its TTL', async (ctx) => {
    if (!reachable) ctx.skip();
    const key = `${prefix}:no-ttl`;
    await redis.set(key, '7');

    const result = await limiter.hit(key, { limit: 5, windowMs: 5_000 });

    expect(result).toMatchObject({ count: 8, limited: true });
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });

  it('peeks and resets', async (ctx) => {
    if (!reachable) ctx.skip();
    const key = `${prefix}:peek`;

    expect(await limiter.peek(key, { limit: 2 })).toEqual({ count: 0, ttlMs: 0, limited: false });
    await limiter.hit(key, { limit: 2, windowMs: 5_000 });
    await limiter.hit(key, { limit: 2, windowMs: 5_000 });
    expect(await limiter.peek(key, { limit: 2 })).toMatchObject({ count: 2, limited: true });

    await limiter.reset(key);
    expect((await limiter.peek(key, { limit: 2 })).count).toBe(0);
  });

  it('recovers from an empty script cache (EVALSHA -> NOSCRIPT -> EVAL)', async (ctx) => {
    if (!reachable) ctx.skip();
    // SCRIPT FLUSH is safe on the dev Redis: callers reload scripts on NOSCRIPT, as this does.
    await redis.script('FLUSH');

    expect((await limiter.hit(`${prefix}:flush`, { limit: 1, windowMs: 5_000 })).count).toBe(1);
  });
});
