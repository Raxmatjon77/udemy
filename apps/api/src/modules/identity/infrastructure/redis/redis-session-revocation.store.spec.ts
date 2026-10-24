import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RedisClient, RedisUnavailableError } from '../../../../shared/redis';
import {
  RedisSessionRevocationStore,
  REVOKED_AMONG_BATCH_SIZE,
  revokedSessionKey,
} from './redis-session-revocation.store';

const SID = '0199d0a0-0000-7000-8000-000000000002';
const SID_2 = '0199d0a0-0000-7000-8000-000000000003';

/** In-memory stand-in for the commands the store uses (SET EX, EXISTS, MULTI/EXEC). */
class FakeRedis {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();
  down = false;
  readonly mgetCalls: number[] = [];

  async set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK'> {
    this.assertUp();
    if (mode !== 'EX') throw new Error('ERR syntax error');
    this.entries.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    this.assertUp();
    const entry = this.entries.get(key);
    return entry !== undefined && entry.expiresAt > Date.now() ? 1 : 0;
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    this.assertUp();
    this.mgetCalls.push(keys.length);
    return keys.map((key) => {
      const entry = this.entries.get(key);
      return entry !== undefined && entry.expiresAt > Date.now() ? entry.value : null;
    });
  }

  multi(): {
    set: (...args: [string, string, 'EX', number]) => unknown;
    exec: () => Promise<[Error | null, unknown][]>;
  } {
    const queued: [string, string, 'EX', number][] = [];
    const chain = {
      set: (...args: [string, string, 'EX', number]) => {
        queued.push(args);
        return chain;
      },
      exec: async (): Promise<[Error | null, unknown][]> => {
        this.assertUp();
        return Promise.all(
          queued.map(async (args) => [null, await this.set(...args)] as [null, unknown]),
        );
      },
    };
    return chain;
  }

  ttlSeconds(key: string): number | undefined {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : Math.round((entry.expiresAt - Date.now()) / 1000);
  }

  private assertUp(): void {
    if (this.down)
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
  }
}

describe('RedisSessionRevocationStore (fake Redis)', () => {
  let redis: FakeRedis;
  let store: RedisSessionRevocationStore;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-10T00:00:00Z'), toFake: ['Date'] });
    redis = new FakeRedis();
    store = new RedisSessionRevocationStore(redis as unknown as RedisClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the design key auth:revoked:sid:{sid}', () => {
    expect(revokedSessionKey(SID)).toBe(`auth:revoked:sid:${SID}`);
    expect(revokedSessionKey(SID.toUpperCase())).toBe(`auth:revoked:sid:${SID}`);
    expect(() => revokedSessionKey('x:*')).toThrow(TypeError);
  });

  it('revoke sets the key with TTL = access-token TTL + 60 s', async () => {
    expect(await store.isRevoked(SID)).toBe(false);

    await store.revoke(SID);

    expect(await store.isRevoked(SID)).toBe(true);
    expect(redis.ttlSeconds(`auth:revoked:sid:${SID}`)).toBe(15 * 60 + 60);

    vi.setSystemTime(Date.now() + 961_000);
    expect(await store.isRevoked(SID)).toBe(false);
  });

  it('revokeMany revokes every session in one transaction', async () => {
    await store.revokeMany([SID, SID_2, SID]);
    expect(await store.isRevoked(SID)).toBe(true);
    expect(await store.isRevoked(SID_2)).toBe(true);
    await expect(store.revokeMany([])).resolves.toBeUndefined();
  });

  it('revokedAmong batches MGETs and returns only the revoked sessions', async () => {
    await store.revokeMany([SID]);
    const many = Array.from(
      { length: REVOKED_AMONG_BATCH_SIZE + 1 },
      (_, i) => `0199d0a0-0000-7000-9000-${String(i).padStart(12, '0')}`,
    );

    const revoked = await store.revokedAmong([SID, SID_2, SID, 'not-a-uuid', ...many]);

    expect([...revoked]).toEqual([SID]);
    // 2 + 501 distinct well-formed ids: two MGETs.
    expect(redis.mgetCalls).toEqual([REVOKED_AMONG_BATCH_SIZE, 3]);
    await expect(store.revokedAmong([])).resolves.toEqual(new Set());
  });

  it('fails closed: every operation throws RedisUnavailableError when Redis is down', async () => {
    redis.down = true;

    await expect(store.isRevoked(SID)).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(store.revoke(SID)).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(store.revokeMany([SID])).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(store.revokedAmong([SID])).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it('treats a failed command inside MULTI as an outage', async () => {
    redis.multi = () => ({
      set: () => undefined,
      exec: async () => [[new Error('OOM command not allowed'), null]],
    });
    await expect(store.revokeMany([SID])).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
