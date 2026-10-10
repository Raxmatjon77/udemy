import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_SCRIPTS, RateLimiter } from './rate-limiter';
import type { RedisClient } from './redis.constants';
import { RedisUnavailableError } from './redis-unavailable.error';

/**
 * In-memory stand-in for the three commands RateLimiter uses. It implements the Lua scripts'
 * semantics in JS and, like a freshly restarted Redis, starts with an empty script cache.
 */
class FakeRedis {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private readonly loadedScripts = new Set<string>();
  down = false;
  readonly calls: string[] = [];

  async evalsha(sha1: string, _numKeys: number, key: string, ...args: string[]): Promise<unknown> {
    this.calls.push('evalsha');
    this.assertUp();
    if (!this.loadedScripts.has(sha1)) {
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    }
    return this.execute(sha1, key, args);
  }

  async eval(source: string, _numKeys: number, key: string, ...args: string[]): Promise<unknown> {
    this.calls.push('eval');
    this.assertUp();
    const lua = Object.values(RATE_LIMIT_SCRIPTS).find((s) => s.source === source);
    if (!lua) throw new Error('ERR unknown script');
    this.loadedScripts.add(lua.sha1);
    return this.execute(lua.sha1, key, args);
  }

  async del(key: string): Promise<number> {
    this.assertUp();
    return this.counters.delete(key) ? 1 : 0;
  }

  private live(key: string): { count: number; expiresAt: number } | undefined {
    const entry = this.counters.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.counters.delete(key);
      return undefined;
    }
    return entry;
  }

  private execute(sha1: string, key: string, args: string[]): [number, number] {
    const entry = this.live(key);
    if (sha1 === RATE_LIMIT_SCRIPTS.peek.sha1) {
      return entry ? [entry.count, entry.expiresAt - Date.now()] : [0, 0];
    }
    const windowMs = Number(args[0]);
    const next = entry ?? { count: 0, expiresAt: Date.now() + windowMs };
    next.count += 1;
    this.counters.set(key, next);
    return [next.count, next.expiresAt - Date.now()];
  }

  private assertUp(): void {
    if (this.down)
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
  }
}

describe('RateLimiter (fake Redis)', () => {
  let redis: FakeRedis;
  let limiter: RateLimiter;
  const rule = { limit: 3, windowMs: 60_000 };

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-10T00:00:00Z') });
    redis = new FakeRedis();
    limiter = new RateLimiter(redis as unknown as RedisClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts hits and limits the hit after `limit`', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await limiter.hit('rl:test:a', rule));

    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.limited)).toEqual([false, false, false, true]);
    expect(results[0]?.ttlMs).toBe(60_000);
  });

  it('keeps a fixed window anchored at the first hit, then starts a new one', async () => {
    await limiter.hit('rl:test:a', rule);
    vi.advanceTimersByTime(45_000);
    const later = await limiter.hit('rl:test:a', rule);
    expect(later).toEqual({ count: 2, ttlMs: 15_000, limited: false });

    vi.advanceTimersByTime(15_000);
    expect(await limiter.hit('rl:test:a', rule)).toEqual({
      count: 1,
      ttlMs: 60_000,
      limited: false,
    });
  });

  it('keeps keys independent', async () => {
    await limiter.hit('rl:test:a', rule);
    expect((await limiter.hit('rl:test:b', rule)).count).toBe(1);
  });

  it('peek reads without counting; limited means one more hit would exceed', async () => {
    expect(await limiter.peek('rl:test:a', rule)).toEqual({ count: 0, ttlMs: 0, limited: false });
    for (let i = 0; i < 3; i += 1) await limiter.hit('rl:test:a', rule);

    expect(await limiter.peek('rl:test:a', rule)).toEqual({
      count: 3,
      ttlMs: 60_000,
      limited: true,
    });
    expect((await limiter.peek('rl:test:a', rule)).count).toBe(3);
  });

  it('reset clears the counter', async () => {
    await limiter.hit('rl:test:a', rule);
    await limiter.reset('rl:test:a');
    expect((await limiter.hit('rl:test:a', rule)).count).toBe(1);
  });

  it('loads the script with EVAL once after NOSCRIPT, then uses EVALSHA', async () => {
    await limiter.hit('rl:test:a', rule);
    await limiter.hit('rl:test:a', rule);

    expect(redis.calls).toEqual(['evalsha', 'eval', 'evalsha']);
  });

  it('fails closed: a Redis failure becomes RedisUnavailableError', async () => {
    redis.down = true;

    await expect(limiter.hit('rl:test:a', rule)).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(limiter.peek('rl:test:a', rule)).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(limiter.reset('rl:test:a')).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it.each([
    [{ limit: 0, windowMs: 1_000 }],
    [{ limit: 1.5, windowMs: 1_000 }],
    [{ limit: 1, windowMs: 0 }],
  ])('rejects an invalid rule %o', async (badRule) => {
    await expect(limiter.hit('rl:test:a', badRule)).rejects.toThrow(TypeError);
  });

  it('rejects an empty or oversized key', async () => {
    await expect(limiter.hit('', rule)).rejects.toThrow(TypeError);
    await expect(limiter.hit('k'.repeat(513), rule)).rejects.toThrow(TypeError);
  });
});
