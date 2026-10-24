import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../shared/config';
import type { RedisClient } from '../../../shared/redis';
import { ProgressStoreUnavailable } from '../domain/learning.errors';
import {
  ASSET,
  COURSE,
  FakeProgressRepository,
  STUDENT,
  testSettings,
  VIDEO,
} from '../application/testing/learning.fakes';
import { learningSettingsFrom, PROGRESS_STORE_PROVIDER } from '../learning.module';
import { DirectProgressStore } from './direct-progress.store';
import { accessCacheKey, RedisAccessCache } from './redis-access-cache';
import { learningRateLimitKey } from './redis-learning-rate-limiter';
import { RedisProgressFlushQueue } from './redis-progress-flush.queue';
import { PROGRESS_SCRIPTS, RECORD_CAS_FAILED, RedisProgressKeys } from './redis-progress.scripts';
import { RECORD_MAX_ATTEMPTS, RedisProgressStore } from './redis-progress.store';

const COURSE_2 = '01900000-0000-7000-8000-00000000c002';
const RUN = '01900000-0000-7000-8000-0000000ff001';

function config(values: Record<string, unknown>): AppConfigService {
  const defaults: Record<string, unknown> = {
    LEARNING_PROGRESS_STORE: 'redis',
    LEARNING_JOBS_ENABLED: true,
    LEARNING_PROGRESS_FLUSH_INTERVAL_MS: 15_000,
    LEARNING_PROGRESS_FLUSH_BATCH_SIZE: 500,
    LEARNING_COVERAGE_BUCKET_S: 5,
    LEARNING_VIDEO_COMPLETE_PCT: 90,
  };
  return { get: (key: string) => values[key] ?? defaults[key] } as unknown as AppConfigService;
}

describe('learning module wiring', () => {
  it('builds LearningSettings from the env', () => {
    const settings = learningSettingsFrom(config({ LEARNING_PROGRESS_STORE: 'direct' }));
    expect(settings).toMatchObject({
      progressStore: 'direct',
      jobsEnabled: true,
      flushIntervalMs: 15_000,
      flushBatchSize: 500,
      bucketSeconds: 5,
      videoCompletePct: 90,
    });
    expect(settings.staleClaimMs).toBe(60_000);
  });

  it('refuses a bucket width the schema does not store (fail at boot, not corrupt data)', () => {
    expect(() => learningSettingsFrom(config({ LEARNING_COVERAGE_BUCKET_S: 10 }))).toThrow(
      /LEARNING_COVERAGE_BUCKET_S=10/,
    );
  });

  it('selects the ProgressStore by LEARNING_PROGRESS_STORE', () => {
    const redis = { kind: 'redis' } as unknown as RedisProgressStore;
    const direct = { kind: 'direct' } as unknown as DirectProgressStore;
    expect(PROGRESS_STORE_PROVIDER.useFactory(testSettings(), redis, direct)).toBe(redis);
    expect(
      PROGRESS_STORE_PROVIDER.useFactory(testSettings({ progressStore: 'direct' }), redis, direct),
    ).toBe(direct);
  });
});

describe('Redis keys', () => {
  it('match design §6', () => {
    const keys = new RedisProgressKeys();
    expect(keys.progress(STUDENT, VIDEO)).toBe(`lp:${STUDENT}:${VIDEO}`);
    expect(keys.coverage(STUDENT, VIDEO)).toBe(`lpc:${STUDENT}:${VIDEO}`);
    expect(keys.activity(STUDENT, COURSE)).toBe(`la:${STUDENT}:${COURSE}`);
    expect(keys.dirty).toBe('lp:dirty');
    expect(accessCacheKey(STUDENT, COURSE)).toBe(`lrn:acc:${STUDENT}:${COURSE}`);
    expect(learningRateLimitKey('heartbeat', STUDENT)).toBe(`rl:lrn:heartbeat:u:${STUDENT}`);
    expect(learningRateLimitKey('certificateVerify', '203.0.113.9')).toBe(
      'rl:lrn:certificateVerify:ip:203.0.113.9',
    );
    expect(new RedisProgressKeys('it:x:').processing(RUN)).toBe(`it:x:lp:proc:${RUN}`);
  });
});

describe('RedisProgressFlushQueue.claim (reply parsing)', () => {
  function queueReplying(reply: unknown) {
    const callBuffer = vi.fn(async () => reply);
    const redis = { callBuffer } as unknown as RedisClient;
    return { queue: new RedisProgressFlushQueue(redis, new RedisProgressKeys()), callBuffer };
  }
  const b = (s: string) => Buffer.from(s);

  it('turns stride-8 records into progress and activity rows', async () => {
    const { queue, callBuffer } = queueReplying([
      b(`p:${STUDENT}:${VIDEO}`),
      b(COURSE),
      b(ASSET),
      b('100'),
      b('130'), // position beyond the duration: clamped
      b('1761307200000'),
      b('1761307100000'),
      Buffer.from([0x80, 0x00, 0x10]),
      b(`a:${STUDENT}:${COURSE}`),
      b(VIDEO),
      b('1761307200000'),
      b(''),
      b(''),
      b(''),
      b(''),
      b(''),
    ]);
    const batch = await queue.claim(RUN, 500, 1761307300000);
    expect(callBuffer).toHaveBeenCalledWith('EVALSHA', [
      PROGRESS_SCRIPTS.claim.sha1,
      '3',
      'lp:dirty',
      'lp:procs',
      `lp:proc:${RUN}`,
      '500',
      '1761307300000',
      RUN,
      '',
    ]);
    expect(batch.claimed).toBe(2);
    expect(batch.invalid).toEqual([]);
    expect(batch.progress).toEqual([
      {
        userId: STUDENT,
        lectureId: VIDEO,
        courseId: COURSE,
        mediaAssetId: ASSET,
        durationSeconds: 100,
        positionSeconds: 100,
        coverage: new Uint8Array([0x80, 0x00, 0x10]),
        firstWatchedAt: new Date(1761307100000),
        lastWatchedAt: new Date(1761307200000),
      },
    ]);
    expect(batch.activity).toEqual([
      { userId: STUDENT, courseId: COURSE, lectureId: VIDEO, accessedAt: new Date(1761307200000) },
    ]);
  });

  it('reports members with a missing or malformed snapshot as invalid', async () => {
    const empty = ['', '', '', '', '', '', ''].map(b);
    const { queue } = queueReplying([
      b(`p:${STUDENT}:${VIDEO}`),
      ...empty, // the hash expired
      b(`a:${STUDENT}:${COURSE_2}`),
      b('not-a-uuid'),
      b('1'),
      ...['', '', '', '', ''].map(b),
      b('x:garbage'),
      ...empty,
    ]);
    const batch = await queue.claim(RUN, 500, 0);
    expect(batch.claimed).toBe(3);
    expect(batch.progress).toEqual([]);
    expect(batch.activity).toEqual([]);
    expect(batch.invalid).toEqual([
      `p:${STUDENT}:${VIDEO}`,
      `a:${STUDENT}:${COURSE_2}`,
      'x:garbage',
    ]);
  });

  it('falls back to EVAL when the script cache is empty', async () => {
    const callBuffer = vi
      .fn()
      .mockRejectedValueOnce(new Error('NOSCRIPT No matching script'))
      .mockResolvedValueOnce([]);
    const queue = new RedisProgressFlushQueue(
      { callBuffer } as unknown as RedisClient,
      new RedisProgressKeys(),
    );
    await expect(queue.claim(RUN, 1, 0)).resolves.toMatchObject({ claimed: 0 });
    expect(callBuffer.mock.calls[1]![0]).toBe('EVAL');
    expect(callBuffer.mock.calls[1]![1][0]).toBe(PROGRESS_SCRIPTS.claim.source);
  });
});

describe('RedisProgressStore.record', () => {
  function storeWith(redis: Partial<Record<'hget' | 'evalsha' | 'eval', unknown>>) {
    const progress = new FakeProgressRepository();
    return {
      progress,
      store: new RedisProgressStore(
        redis as unknown as RedisClient,
        new RedisProgressKeys(),
        progress,
        testSettings(),
      ),
    };
  }
  const input = {
    userId: STUDENT,
    courseId: COURSE,
    lectureId: VIDEO,
    mediaAssetId: ASSET,
    durationSeconds: 100,
    positionSeconds: 30,
    ranges: [{ from: 0, to: 30 }],
    nowMs: 1_761_307_200_000,
  };

  it('seeds a missing key from the stored bitmap of the same asset (args 11-14)', async () => {
    const evalsha = vi.fn(async () => 9);
    const { store, progress } = storeWith({ hget: vi.fn(async () => null), evalsha });
    progress.rows.set(`${STUDENT}:${VIDEO}`, {
      userId: STUDENT,
      lectureId: VIDEO,
      courseId: COURSE,
      mediaAssetId: ASSET,
      durationSeconds: 100,
      positionSeconds: 10,
      coverage: new Uint8Array([0xe0, 0, 0]),
      firstWatchedAt: new Date(input.nowMs - 120_000),
      lastWatchedAt: new Date(input.nowMs - 60_000),
    });
    const result = await store.record(input);
    expect(result).toEqual({ coveredBuckets: 9, bucketCount: 20, droppedSeconds: 0 });
    const args = evalsha.mock.calls[0] as unknown as unknown[];
    // sha, numkeys, 4 keys, then ARGV
    const argv = args.slice(6);
    expect(argv[0]).toBe(''); // CAS: no hash yet
    expect(argv[10]).toBe('1'); // seed
    expect(argv[11]).toEqual(Buffer.from([0xe0, 0, 0]));
    expect(argv[13]).toBe(String(input.nowMs - 60_000)); // seed's last heartbeat
    expect(argv.slice(14)).toEqual(['0', '5']); // buckets 0..5
  });

  it('does not seed from a stored bitmap of another asset (D3 reset)', async () => {
    const evalsha = vi.fn(async () => 6);
    const { store, progress } = storeWith({ hget: vi.fn(async () => null), evalsha });
    progress.rows.set(`${STUDENT}:${VIDEO}`, {
      userId: STUDENT,
      lectureId: VIDEO,
      courseId: COURSE,
      mediaAssetId: COURSE_2,
      durationSeconds: 100,
      positionSeconds: 10,
      coverage: new Uint8Array([0xff, 0xff, 0xf0]),
      firstWatchedAt: new Date(0),
      lastWatchedAt: new Date(0),
    });
    await store.record(input);
    const argv = (evalsha.mock.calls[0] as unknown as unknown[]).slice(6);
    expect(argv[10]).toBe('0');
  });

  it('retries a lost compare-and-set, then answers 503 (the player keeps the batch)', async () => {
    const evalsha = vi.fn(async () => RECORD_CAS_FAILED);
    const hget = vi.fn(async () => '1761307190000');
    const { store } = storeWith({ hget, evalsha });
    await expect(store.record(input)).rejects.toBeInstanceOf(ProgressStoreUnavailable);
    expect(evalsha).toHaveBeenCalledTimes(RECORD_MAX_ATTEMPTS);
    expect(hget).toHaveBeenCalledTimes(RECORD_MAX_ATTEMPTS);
  });

  it('uses the buffered heartbeat time for the plausibility budget', async () => {
    const evalsha = vi.fn(async () => 2);
    // 4 s since the last heartbeat: budget 4 x 2.5 + 10 = 20 s, so only the newest range counts
    const { store } = storeWith({ hget: vi.fn(async () => String(input.nowMs - 4_000)), evalsha });
    const result = await store.record({
      ...input,
      ranges: [
        { from: 0, to: 30 },
        { from: 40, to: 50 },
      ],
    });
    expect(result.droppedSeconds).toBe(30);
    const argv = (evalsha.mock.calls[0] as unknown as unknown[]).slice(6);
    expect(argv[0]).toBe(String(input.nowMs - 4_000));
    expect(argv.slice(14)).toEqual(['8', '9']);
  });

  it('maps a Redis failure to 503', async () => {
    const { store } = storeWith({
      hget: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    });
    await expect(store.record(input)).rejects.toBeInstanceOf(ProgressStoreUnavailable);
  });
});

describe('RedisAccessCache', () => {
  it('reads 1/0, treats anything else and errors as a miss', async () => {
    const values = new Map([[accessCacheKey(STUDENT, COURSE), '1']]);
    const redis = {
      get: vi.fn(async (key: string) => {
        if (key.includes(COURSE_2)) throw new Error('down');
        return values.get(key) ?? null;
      }),
      set: vi.fn(async () => Promise.reject(new Error('down'))),
    } as unknown as RedisClient;
    const cache = new RedisAccessCache(redis);
    await expect(cache.get(STUDENT, COURSE)).resolves.toBe(true);
    await expect(cache.get(STUDENT, VIDEO)).resolves.toBeNull();
    await expect(cache.get(STUDENT, COURSE_2)).resolves.toBeNull();
    await expect(cache.set(STUDENT, COURSE, false)).resolves.toBeUndefined();
  });
});

describe('DirectProgressStore', () => {
  it("upserts only this heartbeat's buckets; the stored bitmap is OR-merged", async () => {
    const progress = new FakeProgressRepository();
    const tx = { run: <T>(work: (trx: never) => Promise<T>) => work({} as never) };
    const store = new DirectProgressStore(
      {} as never,
      progress,
      tx as never,
      testSettings({ progressStore: 'direct' }),
    );
    const base = 1_761_307_200_000;
    const first = await store.record({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: VIDEO,
      mediaAssetId: ASSET,
      durationSeconds: 100,
      positionSeconds: 30,
      ranges: [{ from: 0, to: 30 }],
      nowMs: base,
    });
    expect(first.coveredBuckets).toBe(6);
    const second = await store.record({
      userId: STUDENT,
      courseId: COURSE,
      lectureId: VIDEO,
      mediaAssetId: ASSET,
      durationSeconds: 100,
      positionSeconds: 60,
      ranges: [{ from: 30, to: 60 }],
      nowMs: base + 30_000,
    });
    expect(second).toEqual({ coveredBuckets: 12, bucketCount: 20, droppedSeconds: 0 });
    expect(progress.activities.get(`${STUDENT}:${COURSE}`)?.lectureId).toBe(VIDEO);
    await expect(store.readBuffered()).resolves.toEqual(new Map());
  });
});
