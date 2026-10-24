import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { RedisClient } from '../../../shared/redis';
import { useIntegrationRedis } from '../../../testing/integration';
import { ASSET, FakeProgressRepository, testSettings } from '../application/testing/learning.fakes';
import { deleteRedisPrefix } from '../testing/learning-it';
import { RedisProgressFlushQueue } from './redis-progress-flush.queue';
import {
  PROGRESS_SCRIPTS,
  RECORD_CAS_FAILED,
  RedisProgressKeys,
  runScript,
} from './redis-progress.scripts';
import { RedisProgressStore } from './redis-progress.store';

/*
 * The Lua side of the write-behind buffer against a real Redis (design D2, schema doc R5, open
 * point 7). Every key lives under a per-file prefix, so the real `lp:dirty` is never touched.
 * The DB side is a fake (seeding is covered here; the SQL by learning.integration.spec.ts).
 */
describe('Redis progress buffer (integration: Redis)', () => {
  const itRedis = useIntegrationRedis();
  const prefix = `it:lrn:${randomUUID().slice(0, 8)}:`;
  const keys = new RedisProgressKeys(prefix);
  const settings = testSettings();
  const base = Date.UTC(2026, 9, 24, 12, 0, 0);

  const redis = (): RedisClient => itRedis.redis as unknown as RedisClient;
  const ids = () => ({
    userId: randomUUID(),
    courseId: randomUUID(),
    lectureId: randomUUID(),
  });
  function makeStore(progress = new FakeProgressRepository()) {
    return {
      progress,
      store: new RedisProgressStore(redis(), keys, progress, settings),
      queue: new RedisProgressFlushQueue(redis(), keys),
    };
  }

  afterAll(async () => {
    if (itRedis.available) await deleteRedisPrefix(itRedis.redis, prefix);
  });

  it('records buckets, position, the resume pointer and both dirty members', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const { store } = makeStore();
    const id = ids();
    const result = await store.record({
      ...id,
      mediaAssetId: ASSET,
      durationSeconds: 100,
      positionSeconds: 30,
      ranges: [{ from: 0, to: 30 }],
      nowMs: base,
    });
    expect(result).toEqual({ coveredBuckets: 6, bucketCount: 20, droppedSeconds: 0 });
    const hash = await itRedis.redis.hgetall(keys.progress(id.userId, id.lectureId));
    expect(hash).toMatchObject({
      c: id.courseId,
      a: ASSET,
      d: '100',
      p: '30',
      hb: String(base),
      f: String(base),
    });
    const bitmap = await itRedis.redis.getBuffer(keys.coverage(id.userId, id.lectureId));
    expect([...bitmap!]).toEqual([0xfc]);
    expect(
      await itRedis.redis.zscore(keys.dirty, keys.progressMember(id.userId, id.lectureId)),
    ).toBe(String(base));
    expect(
      await itRedis.redis.zscore(keys.dirty, keys.activityMember(id.userId, id.courseId)),
    ).toBe(String(base));
    expect(await itRedis.redis.ttl(keys.progress(id.userId, id.lectureId))).toBeGreaterThan(0);
    expect(await store.readBufferedActivity(id.userId, id.courseId)).toEqual({
      lectureId: id.lectureId,
      atMs: base,
    });
  });

  it('applies the plausibility budget from the buffered heartbeat time', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const { store } = makeStore();
    const id = ids();
    const hb = { ...id, mediaAssetId: ASSET, durationSeconds: 3600 };
    await store.record({ ...hb, positionSeconds: 10, ranges: [{ from: 0, to: 10 }], nowMs: base });
    // 4 s later: budget 20 s; a 3000 s "range" (a seek) is dropped
    const forged = await store.record({
      ...hb,
      positionSeconds: 3600,
      ranges: [{ from: 10, to: 3010 }],
      nowMs: base + 4_000,
    });
    expect(forged.coveredBuckets).toBe(2);
    expect(forged.droppedSeconds).toBe(3000);
  });

  it('keeps the first-dirty score on later heartbeats (ZADD NX) and a monotonic hb', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const { store } = makeStore();
    const id = ids();
    const hb = { ...id, mediaAssetId: ASSET, durationSeconds: 100, ranges: [] };
    await store.record({ ...hb, positionSeconds: 1, nowMs: base });
    await store.record({ ...hb, positionSeconds: 2, nowMs: base + 10_000 });
    // a replica with a slow clock
    await store.record({ ...hb, positionSeconds: 3, nowMs: base + 5_000 });
    const member = keys.progressMember(id.userId, id.lectureId);
    expect(await itRedis.redis.zscore(keys.dirty, member)).toBe(String(base));
    expect(await itRedis.redis.hget(keys.progress(id.userId, id.lectureId), 'hb')).toBe(
      String(base + 10_000),
    );
    expect(await itRedis.redis.hget(keys.progress(id.userId, id.lectureId), 'p')).toBe('3');
  });

  it('resets the bitmap when the asset or the duration changes (D3)', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const { store } = makeStore();
    const id = ids();
    await store.record({
      ...id,
      mediaAssetId: ASSET,
      durationSeconds: 100,
      positionSeconds: 30,
      ranges: [{ from: 0, to: 30 }],
      nowMs: base,
    });
    const swapped = await store.record({
      ...id,
      mediaAssetId: randomUUID(),
      durationSeconds: 120,
      positionSeconds: 35,
      ranges: [{ from: 30, to: 35 }],
      nowMs: base + 5_000,
    });
    expect(swapped).toMatchObject({ coveredBuckets: 1, bucketCount: 24 });
  });

  it('seeds a missing key from the stored bitmap of the same asset', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const progress = new FakeProgressRepository();
    const { store } = makeStore(progress);
    const id = ids();
    progress.rows.set(`${id.userId}:${id.lectureId}`, {
      ...id,
      mediaAssetId: ASSET,
      durationSeconds: 100,
      positionSeconds: 50,
      coverage: new Uint8Array([0xff, 0xc0, 0x00]), // 10 buckets
      firstWatchedAt: new Date(base - 86_400_000),
      lastWatchedAt: new Date(base - 3_600_000),
    });
    const result = await store.record({
      ...id,
      mediaAssetId: ASSET,
      durationSeconds: 100,
      positionSeconds: 55,
      ranges: [{ from: 50, to: 55 }],
      nowMs: base,
    });
    expect(result.coveredBuckets).toBe(11);
  });

  it('the record script refuses a stale compare-and-set value', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const { store } = makeStore();
    const id = ids();
    const hb = { ...id, mediaAssetId: ASSET, durationSeconds: 100, ranges: [] };
    await store.record({ ...hb, positionSeconds: 1, nowMs: base });
    const reply = await runScript(
      redis(),
      PROGRESS_SCRIPTS.record,
      [
        keys.progress(id.userId, id.lectureId),
        keys.coverage(id.userId, id.lectureId),
        keys.dirty,
        keys.activity(id.userId, id.courseId),
      ],
      [
        '', // "no hash yet": stale
        id.courseId,
        ASSET,
        '100',
        '99',
        String(base + 1_000),
        '60',
        keys.progressMember(id.userId, id.lectureId),
        keys.activityMember(id.userId, id.courseId),
        id.lectureId,
        '0',
        '',
        '0',
        '0',
      ],
    );
    expect(reply).toBe(RECORD_CAS_FAILED);
    expect(await itRedis.redis.hget(keys.progress(id.userId, id.lectureId), 'p')).toBe('1');
  });

  it('parallel heartbeats of one lecture never lose bits (CAS + retry)', async (ctx) => {
    itRedis.skipIfUnavailable(ctx);
    const { store } = makeStore();
    const id = ids();
    const hb = { ...id, mediaAssetId: ASSET, durationSeconds: 100 };
    await store.record({ ...hb, positionSeconds: 0, ranges: [], nowMs: base });
    const results = await Promise.allSettled(
      [0, 1, 2].map((i) =>
        store.record({
          ...hb,
          positionSeconds: (i + 1) * 5,
          ranges: [{ from: i * 5, to: (i + 1) * 5 }],
          nowMs: base + 60_000,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const bits = await itRedis.redis.bitcount(keys.coverage(id.userId, id.lectureId));
    expect(bits).toBe(ok); // every accepted heartbeat's bucket is there; rejected ones answered 503
    expect(ok).toBeGreaterThanOrEqual(1);
  });

  describe('flush queue: claim / ack / re-queue / recovery', () => {
    async function dirtyOne(store: RedisProgressStore, nowMs: number) {
      const id = ids();
      await store.record({
        ...id,
        mediaAssetId: ASSET,
        durationSeconds: 100,
        positionSeconds: 20,
        ranges: [{ from: 0, to: 20 }],
        nowMs,
      });
      return id;
    }

    it('claims atomically into a processing set with snapshots, then ack deletes it', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      await deleteRedisPrefix(itRedis.redis, prefix);
      const { store, queue } = makeStore();
      const id = await dirtyOne(store, base);
      const runId = randomUUID();
      const batch = await queue.claim(runId, 500, base + 1_000);
      expect(batch.claimed).toBe(2);
      expect(batch.invalid).toEqual([]);
      expect(batch.progress).toEqual([
        expect.objectContaining({
          userId: id.userId,
          lectureId: id.lectureId,
          courseId: id.courseId,
          durationSeconds: 100,
          positionSeconds: 20,
          lastWatchedAt: new Date(base),
        }),
      ]);
      expect([...batch.progress[0]!.coverage]).toEqual([0xf0]);
      expect(batch.activity).toEqual([
        {
          userId: id.userId,
          courseId: id.courseId,
          lectureId: id.lectureId,
          accessedAt: new Date(base),
        },
      ]);
      expect(await itRedis.redis.zcard(keys.dirty)).toBe(0);
      expect(await itRedis.redis.zcard(keys.processing(runId))).toBe(2);
      expect(await itRedis.redis.zscore(keys.runs, runId)).toBe(String(base + 1_000));

      await queue.ack(runId);
      expect(await itRedis.redis.exists(keys.processing(runId))).toBe(0);
      expect(await itRedis.redis.zscore(keys.runs, runId)).toBeNull();
    });

    it('a heartbeat after the claim re-dirties its member; re-queue keeps the newer score', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      await deleteRedisPrefix(itRedis.redis, prefix);
      const { store, queue } = makeStore();
      const id = await dirtyOne(store, base);
      const runId = randomUUID();
      await queue.claim(runId, 500, base + 1_000);
      await store.record({
        ...id,
        mediaAssetId: ASSET,
        durationSeconds: 100,
        positionSeconds: 25,
        ranges: [{ from: 20, to: 25 }],
        nowMs: base + 5_000,
      });
      const member = keys.progressMember(id.userId, id.lectureId);
      expect(await itRedis.redis.zscore(keys.dirty, member)).toBe(String(base + 5_000));
      // the heartbeat re-dirtied both members, so nothing is moved back (ZADD NX)
      expect(await queue.requeue(runId)).toBe(0);
      expect(await itRedis.redis.zscore(keys.dirty, member)).toBe(String(base + 5_000));
      expect(await itRedis.redis.zcard(keys.dirty)).toBe(2);
      expect(await itRedis.redis.zcard(keys.runs)).toBe(0);
    });

    it('recovers only claims older than the cutoff', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      await deleteRedisPrefix(itRedis.redis, prefix);
      const { store, queue } = makeStore();
      await dirtyOne(store, base);
      const crashed = randomUUID();
      await queue.claim(crashed, 500, base);
      await dirtyOne(store, base + 1_000);
      const live = randomUUID();
      await queue.claim(live, 500, base + 100_000);
      expect(await queue.recoverStale(base + 100_000 - 60_000)).toBe(2);
      expect(await itRedis.redis.exists(keys.processing(crashed))).toBe(0);
      expect(await itRedis.redis.exists(keys.processing(live))).toBe(1);
      expect(await itRedis.redis.zcard(keys.dirty)).toBe(2);
    });

    it('concurrent claims never hand the same member to two runs', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      await deleteRedisPrefix(itRedis.redis, prefix);
      const { store, queue } = makeStore();
      for (let i = 0; i < 20; i++) await dirtyOne(store, base + i);
      const batches = await Promise.all(
        Array.from({ length: 5 }, () => queue.claim(randomUUID(), 8, base + 100)),
      );
      const members = batches.flatMap((b) => [
        ...b.progress.map((r) => `p:${r.userId}:${r.lectureId}`),
        ...b.activity.map((r) => `a:${r.userId}:${r.courseId}`),
      ]);
      expect(members).toHaveLength(40);
      expect(new Set(members).size).toBe(40);
    });

    it('reports a member whose hash expired as invalid', async (ctx) => {
      itRedis.skipIfUnavailable(ctx);
      await deleteRedisPrefix(itRedis.redis, prefix);
      const { store, queue } = makeStore();
      const id = await dirtyOne(store, base);
      await itRedis.redis.del(keys.progress(id.userId, id.lectureId));
      const batch = await queue.claim(randomUUID(), 500, base);
      expect(batch.invalid).toEqual([keys.progressMember(id.userId, id.lectureId)]);
      expect(batch.activity).toHaveLength(1);
    });
  });
});
