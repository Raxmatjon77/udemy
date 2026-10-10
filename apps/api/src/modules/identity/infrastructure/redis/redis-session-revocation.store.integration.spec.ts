import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisSessionRevocationStore, revokedSessionKey } from './redis-session-revocation.store';

/**
 * Against the dev Redis (REDIS_URL, default: the compose port 56379). Every test skips
 * cleanly when Redis is unreachable.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:56379';

describe('RedisSessionRevocationStore (integration, real Redis)', () => {
  let redis: Redis;
  let store: RedisSessionRevocationStore;
  let reachable = false;
  const sids = [randomUUID(), randomUUID(), randomUUID()];

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
    store = new RedisSessionRevocationStore(redis);
  });

  afterAll(async () => {
    if (reachable) {
      await redis.del(...sids.map(revokedSessionKey));
      await redis.quit();
    } else {
      redis.disconnect();
    }
  });

  it('revokes one session with a 960 s TTL', async (ctx) => {
    if (!reachable) ctx.skip();
    const [sid = ''] = sids;

    expect(await store.isRevoked(sid)).toBe(false);
    await store.revoke(sid);

    expect(await store.isRevoked(sid)).toBe(true);
    const ttl = await redis.ttl(revokedSessionKey(sid));
    expect(ttl).toBeGreaterThan(955);
    expect(ttl).toBeLessThanOrEqual(960);
  });

  it('revokes many sessions atomically', async (ctx) => {
    if (!reachable) ctx.skip();
    const [, a = '', b = ''] = sids;

    await store.revokeMany([a, b]);

    expect(await store.isRevoked(a)).toBe(true);
    expect(await store.isRevoked(b)).toBe(true);
    expect(await redis.ttl(revokedSessionKey(b))).toBeGreaterThan(955);
  });
});
