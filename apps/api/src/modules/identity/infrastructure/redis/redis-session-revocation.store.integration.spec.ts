import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useIntegrationRedis } from '../../../../testing/integration';
import { RedisSessionRevocationStore, revokedSessionKey } from './redis-session-revocation.store';

/**
 * Against the integration Redis (IT_REDIS_URL, default: the dev compose port 56379; see
 * src/testing/integration.ts: skipped locally when unreachable, a failure with CI=true).
 */
describe('RedisSessionRevocationStore (integration, real Redis)', () => {
  const itRedis = useIntegrationRedis();
  let redis: Redis;
  let store: RedisSessionRevocationStore;
  const sids = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(() => {
    if (!itRedis.available) return;
    redis = itRedis.redis;
    store = new RedisSessionRevocationStore(redis);
  });

  afterAll(async () => {
    if (!itRedis.available) return;
    await redis.del(...sids.map(revokedSessionKey));
  });

  it('revokes one session with a 960 s TTL', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const [sid = ''] = sids;

    expect(await store.isRevoked(sid)).toBe(false);
    await store.revoke(sid);

    expect(await store.isRevoked(sid)).toBe(true);
    const ttl = await redis.ttl(revokedSessionKey(sid));
    expect(ttl).toBeGreaterThan(955);
    expect(ttl).toBeLessThanOrEqual(960);
  });

  it('revokes many sessions atomically', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const [, a = '', b = ''] = sids;

    await store.revokeMany([a, b]);

    expect(await store.isRevoked(a)).toBe(true);
    expect(await store.isRevoked(b)).toBe(true);
    expect(await redis.ttl(revokedSessionKey(b))).toBeGreaterThan(955);
  });
});
