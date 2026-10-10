import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
    // Only this file's keys (KEYS is fine on the dev/CI Redis; never FLUSH a shared instance).
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  it('counts atomically under concurrency and sets the TTL once', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const key = `${prefix}:concurrent`;
    // A window far longer than any stall a loaded machine can produce: with 10 s, a slow Redis
    // round trip let the window expire mid-burst and the count restart at 1.
    const windowMs = 120_000;
    const startedAt = Date.now();

    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.hit(key, { limit: 20, windowMs })),
    );

    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(results.filter((r) => r.limited)).toHaveLength(5);
    // Set once, by the first hit: the TTL has only run down since (re-setting it on every hit
    // would also pass `<= windowMs`, but this bound comes from the start of the burst).
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThanOrEqual(windowMs - (Date.now() - startedAt) - 5);
    expect(ttl).toBeLessThanOrEqual(windowMs);
  });

  it('does not extend the window on later hits', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const key = `${prefix}:window`;
    // Long enough that no stall can expire it between the two hits.
    const rule = { limit: 5, windowMs: 60_000 };

    await limiter.hit(key, rule);
    const firstDoneAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const secondSentAt = Date.now();
    const second = await limiter.hit(key, rule);

    // The window started no later than `firstDoneAt` and the second hit ran no earlier than
    // `secondSentAt`, so an unextended TTL is at most windowMs minus that gap (a few ms of slack
    // for PTTL rounding), however slow Redis answered. An extended one would be ~windowMs.
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeLessThanOrEqual(rule.windowMs - (secondSentAt - firstDoneAt) + 5);
  });

  it('starts a new window once the old one expired', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const key = `${prefix}:expiry`;
    const rule = { limit: 5, windowMs: 300 };

    const first = await limiter.hit(key, rule);
    await new Promise((resolve) => setTimeout(resolve, first.ttlMs + 50));

    expect(await limiter.hit(key, rule)).toMatchObject({ count: 1, limited: false });
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
    // No SCRIPT FLUSH: it empties the cache server-wide, under every other process sharing this
    // Redis. Instead this limiter's EVALSHA asks for a digest that was never loaded, so the real
    // Redis answers with a real NOSCRIPT error and the limiter must fall back to EVAL.
    const unknownSha = createHash('sha1').update(`never-loaded:${randomUUID()}`).digest('hex');
    type Command = (...args: unknown[]) => Promise<unknown>;
    const realEvalsha = redis.evalsha.bind(redis) as Command;
    const realEval = redis.eval.bind(redis) as Command;
    const evalsha = vi.fn((...args: unknown[]) => realEvalsha(unknownSha, ...args.slice(1)));
    const evalSpy = vi.fn((...args: unknown[]) => realEval(...args));
    const noScriptRedis = new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop === 'evalsha') return evalsha;
        if (prop === 'eval') return evalSpy;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const flushedLimiter = new RateLimiter(noScriptRedis);

    expect((await flushedLimiter.hit(`${prefix}:flush`, { limit: 1, windowMs: 5_000 })).count).toBe(
      1,
    );
    expect(evalsha).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledTimes(1);
  });
});
