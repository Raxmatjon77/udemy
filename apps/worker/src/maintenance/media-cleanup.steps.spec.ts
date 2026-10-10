import type {
  AbortedUpload,
  AssetObjectsToDelete,
  DB,
  PurgedAsset,
  PurgeOptions,
  SourceToDelete,
  Transaction,
} from '@udemy/db';
import type { MultipartRef, MultipartUploadInfo, ObjectRef } from '@udemy/storage';
import { describe, expect, it } from 'vitest';
import {
  type CleanupStorage,
  expiredSourcesStep,
  failedSourcesStep,
  type MediaCleanupContext,
  type MediaCleanupOptions,
  type MediaCleanupSql,
  mediaCleanupSteps,
  orphanMultipartsStep,
  pendingObjectDeletionsStep,
  purgeStep,
  staleUploadsStep,
  uploadsPrefixOf,
} from './media-cleanup.steps';

const TRX = { isTransaction: true } as unknown as Transaction<DB>;
const NOW = new Date('2026-10-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const OWNER = '0199c8a0-0000-7000-8000-00000000000a';
const asset = (n: number): string => `0199c8a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const sourceKey = (id: string, owner = OWNER): string => `uploads/${owner}/${id}/source`;

const OPTIONS: MediaCleanupOptions = {
  batchSize: 2,
  uploadTtlHours: 24,
  neverUsedGraceHours: 24,
  releasedGraceDays: 7,
  sourceRetentionDays: 7,
};

/** Returns pre-scripted batches (one array per call) and records every call. */
class FakeSql implements MediaCleanupSql {
  readonly calls: string[] = [];
  staleBatches: AbortedUpload[][] = [];
  live = new Set<string>();
  liveQueries: string[][] = [];
  purgeBatches: PurgedAsset[][] = [];
  purgeOptions: PurgeOptions[] = [];
  purgedEvents: { trx: Transaction<DB>; assetId: string }[] = [];
  pendingBatches: AssetObjectsToDelete[][] = [];
  readyBatches: SourceToDelete[][] = [];
  readyOptions: { retentionDays: number; batchSize: number }[] = [];
  failedBatches: SourceToDelete[][] = [];
  markedObjects: string[] = [];
  markedSources: string[][] = [];

  async abortStaleUploads(
    _trx: Transaction<DB>,
    options: { ttlHours: number; batchSize: number },
  ): Promise<AbortedUpload[]> {
    this.calls.push(`abortStaleUploads(${options.ttlHours},${options.batchSize})`);
    return this.staleBatches.shift() ?? [];
  }
  async findLiveUploadIds(_trx: Transaction<DB>, ids: readonly string[]): Promise<Set<string>> {
    this.liveQueries.push([...ids]);
    return new Set(ids.filter((id) => this.live.has(id)));
  }
  async purgeUnusedAssets(_trx: Transaction<DB>, options: PurgeOptions): Promise<PurgedAsset[]> {
    this.calls.push('purgeUnusedAssets');
    this.purgeOptions.push(options);
    return this.purgeBatches.shift() ?? [];
  }
  async insertMediaPurged(trx: Transaction<DB>, purged: PurgedAsset): Promise<void> {
    this.purgedEvents.push({ trx, assetId: purged.id });
  }
  async markAssetObjectsDeleted(_trx: Transaction<DB>, assetId: string): Promise<boolean> {
    this.markedObjects.push(assetId);
    return true;
  }
  async findAssetsPendingObjectDeletion(): Promise<AssetObjectsToDelete[]> {
    this.calls.push('findAssetsPendingObjectDeletion');
    return this.pendingBatches.shift() ?? [];
  }
  async findExpiredReadySources(
    _trx: Transaction<DB>,
    options: { retentionDays: number; batchSize: number },
  ): Promise<SourceToDelete[]> {
    this.calls.push('findExpiredReadySources');
    this.readyOptions.push(options);
    return this.readyBatches.shift() ?? [];
  }
  async findStaleFailedSources(): Promise<SourceToDelete[]> {
    this.calls.push('findStaleFailedSources');
    return this.failedBatches.shift() ?? [];
  }
  async markSourcesDeleted(_trx: Transaction<DB>, ids: readonly string[]): Promise<number> {
    this.markedSources.push([...ids]);
    return ids.length;
  }
}

/** In-memory storage: records calls, fails on demand, honours the listing prefix. */
class FakeStorage implements CleanupStorage {
  readonly aborted: MultipartRef[] = [];
  readonly deletedPrefixes: string[] = [];
  readonly deletedObjects: string[] = [];
  uploads: MultipartUploadInfo[] = [];
  listError: Error | undefined;
  failAbort = new Set<string>();
  failPrefix = new Set<string>();
  failDelete = new Set<string>();

  async abortMultipartUpload(input: MultipartRef): Promise<void> {
    if (this.failAbort.has(input.uploadId)) throw new Error('S3 unavailable');
    this.aborted.push(input);
  }
  async *listMultipartUploads(input: {
    bucket: 'uploads' | 'media';
    prefix: string;
  }): AsyncGenerator<MultipartUploadInfo> {
    if (this.listError !== undefined) throw this.listError;
    for (const upload of this.uploads) {
      if (input.bucket === 'uploads' && upload.key.startsWith(input.prefix)) yield upload;
    }
  }
  async deletePrefix(input: { bucket: 'uploads' | 'media'; prefix: string }): Promise<number> {
    if (this.failPrefix.has(input.prefix)) throw new Error('S3 unavailable');
    this.deletedPrefixes.push(`${input.bucket}:${input.prefix}`);
    return 1;
  }
  async deleteObject(input: ObjectRef): Promise<void> {
    if (this.failDelete.has(input.key)) throw new Error('S3 unavailable');
    this.deletedObjects.push(`${input.bucket}:${input.key}`);
  }
}

interface Harness {
  ctx: MediaCleanupContext;
  sql: FakeSql;
  storage: FakeStorage;
  /** How many runLocked calls were made. */
  lockCalls: () => number;
  logs: { level: 'warn' | 'error'; message: string }[];
}

/** `lock(n)` decides whether the n-th runLocked call (0-based) gets the advisory lock. */
function harness(lock: (call: number) => boolean = () => true, maxBatches = 10): Harness {
  const sql = new FakeSql();
  const storage = new FakeStorage();
  const logs: Harness['logs'] = [];
  let calls = 0;
  const ctx: MediaCleanupContext = {
    sql,
    storage,
    async runLocked(fn) {
      const n = calls++;
      return lock(n) ? { acquired: true, value: await fn(TRX) } : { acquired: false };
    },
    maxBatches,
    shouldStop: () => false,
    log: {
      warn: (_c, message) => logs.push({ level: 'warn', message }),
      error: (_c, message) => logs.push({ level: 'error', message }),
    },
    now: () => NOW,
  };
  return { ctx, sql, storage, lockCalls: () => calls, logs };
}

const stale = (n: number): AbortedUpload => ({
  id: asset(n),
  sourceKey: sourceKey(asset(n)),
  s3UploadId: `upload-${n}`,
});
const purged = (n: number, owner = OWNER): PurgedAsset => ({
  id: asset(n),
  ownerId: owner,
  sourceKey: sourceKey(asset(n), owner),
  outputPrefix: `assets/${asset(n)}/a1/`,
  status: 'READY',
});
const source = (n: number): SourceToDelete => ({ id: asset(n), sourceKey: sourceKey(asset(n)) });
const multipart = (key: string, uploadId: string, hoursAgo: number | undefined) => ({
  key,
  uploadId,
  initiated: hoursAgo === undefined ? undefined : new Date(NOW.getTime() - hoursAgo * HOUR),
});

describe('A. stale uploads', () => {
  it('aborts each ABORTED row in S3 after its DB batch and loops while batches are full', async () => {
    const h = harness();
    h.sql.staleBatches = [[stale(1), stale(2)], [stale(3)]];
    const result = await staleUploadsStep(OPTIONS).run(h.ctx);
    expect(result).toEqual({
      status: 'completed',
      counts: { assets_aborted: 3, multiparts_aborted: 3 },
      s3Failures: 0,
    });
    expect(h.sql.calls).toEqual(['abortStaleUploads(24,2)', 'abortStaleUploads(24,2)']);
    expect(h.storage.aborted).toEqual([
      { bucket: 'uploads', key: sourceKey(asset(1)), uploadId: 'upload-1' },
      { bucket: 'uploads', key: sourceKey(asset(2)), uploadId: 'upload-2' },
      { bucket: 'uploads', key: sourceKey(asset(3)), uploadId: 'upload-3' },
    ]);
  });

  it('counts an S3 failure, logs it and carries on (step B retries the multipart)', async () => {
    const h = harness();
    h.sql.staleBatches = [[stale(1), stale(2)], []];
    h.storage.failAbort.add('upload-1');
    const result = await staleUploadsStep(OPTIONS).run(h.ctx);
    expect(result).toMatchObject({
      status: 'completed',
      counts: { assets_aborted: 2, multiparts_aborted: 1 },
      s3Failures: 1,
    });
    expect(h.logs).toEqual([{ level: 'warn', message: expect.stringMatching(/step B retries/) }]);
  });

  it('stops as "locked" without any S3 call when another replica holds the lock', async () => {
    const h = harness(() => false);
    h.sql.staleBatches = [[stale(1)]];
    const result = await staleUploadsStep(OPTIONS).run(h.ctx);
    expect(result.status).toBe('locked');
    expect(h.sql.calls).toEqual([]);
    expect(h.storage.aborted).toEqual([]);
  });

  it('never runs more than maxBatches batches', async () => {
    const h = harness(() => true, 2);
    h.sql.staleBatches = [
      [stale(1), stale(2)],
      [stale(3), stale(4)],
      [stale(5), stale(6)],
    ];
    const result = await staleUploadsStep(OPTIONS).run(h.ctx);
    expect(result.counts.assets_aborted).toBe(4);
    expect(h.sql.calls).toHaveLength(2);
  });
});

describe('B. orphan multipart uploads', () => {
  const live = sourceKey(asset(1));
  const orphan = sourceKey(asset(2));

  it('aborts uploads older than 24 h whose UploadId has no live row; skips young, undated and foreign keys', async () => {
    const h = harness();
    h.storage.uploads = [
      multipart(live, 'live-1', 48),
      multipart(orphan, 'orphan-1', 48),
      multipart(orphan, 'orphan-2', 25),
      multipart(sourceKey(asset(3)), 'young', 23),
      multipart(sourceKey(asset(4)), 'undated', undefined),
      multipart('other/prefix/source', 'foreign', 48),
    ];
    h.sql.live.add('live-1');
    const result = await orphanMultipartsStep(OPTIONS).run(h.ctx);
    // batchSize 2: two DB checks for the three old candidates
    expect(h.sql.liveQueries).toEqual([['live-1', 'orphan-1'], ['orphan-2']]);
    expect(h.storage.aborted.map((a) => a.uploadId)).toEqual(['orphan-1', 'orphan-2']);
    expect(h.storage.aborted[0]).toEqual({ bucket: 'uploads', key: orphan, uploadId: 'orphan-1' });
    expect(result).toEqual({
      status: 'completed',
      counts: { multiparts_checked: 3, multiparts_aborted: 2 },
      s3Failures: 0,
    });
  });

  it('honours a narrower uploads prefix and a custom minimum age', async () => {
    const h = harness();
    const mine = `uploads/${OWNER}/`;
    h.storage.uploads = [
      multipart(orphan, 'mine', 0.5),
      multipart(sourceKey(asset(5), '0199c8a0-0000-7000-8000-0000000000ff'), 'theirs', 48),
    ];
    await orphanMultipartsStep({
      ...OPTIONS,
      uploadsPrefix: mine,
      orphanMultipartMinAgeHours: 0,
    }).run(h.ctx);
    expect(h.storage.aborted.map((a) => a.uploadId)).toEqual(['mine']);
  });

  it('a listing failure is logged and counted; nothing is aborted', async () => {
    const h = harness();
    h.storage.listError = new Error('connect ECONNREFUSED');
    const result = await orphanMultipartsStep(OPTIONS).run(h.ctx);
    expect(result).toMatchObject({ status: 'completed', s3Failures: 1 });
    expect(h.sql.liveQueries).toEqual([]);
  });

  it('an abort failure is counted and the next orphan is still aborted', async () => {
    const h = harness();
    h.storage.uploads = [multipart(orphan, 'o1', 48), multipart(orphan, 'o2', 48)];
    h.storage.failAbort.add('o1');
    const result = await orphanMultipartsStep(OPTIONS).run(h.ctx);
    expect(result).toMatchObject({ counts: { multiparts_aborted: 1 }, s3Failures: 1 });
    expect(h.storage.aborted.map((a) => a.uploadId)).toEqual(['o2']);
  });

  it('aborts nothing when the DB check cannot take the lock', async () => {
    const h = harness(() => false);
    h.storage.uploads = [multipart(orphan, 'o1', 48)];
    const result = await orphanMultipartsStep(OPTIONS).run(h.ctx);
    expect(result.status).toBe('locked');
    expect(h.storage.aborted).toEqual([]);
  });
});

describe('C. purge', () => {
  it('purges with MediaPurged in the purge transaction, deletes both prefixes, then marks', async () => {
    const h = harness();
    h.sql.purgeBatches = [[purged(1), purged(2)], [purged(3)]];
    const result = await purgeStep(OPTIONS).run(h.ctx);
    expect(result).toEqual({
      status: 'completed',
      counts: { assets_purged: 3, assets_objects_deleted: 3 },
      s3Failures: 0,
    });
    expect(h.sql.purgeOptions[0]).toEqual({
      neverUsedGraceHours: 24,
      releasedGraceDays: 7,
      batchSize: 2,
    });
    expect(h.sql.purgedEvents).toEqual([
      { trx: TRX, assetId: asset(1) },
      { trx: TRX, assetId: asset(2) },
      { trx: TRX, assetId: asset(3) },
    ]);
    expect(h.storage.deletedPrefixes.slice(0, 2)).toEqual([
      `uploads:uploads/${OWNER}/${asset(1)}/`,
      `media:assets/${asset(1)}/`,
    ]);
    expect(h.sql.markedObjects).toEqual([asset(1), asset(2), asset(3)]);
    // purge batch, mark batch, purge batch, mark batch
    expect(h.lockCalls()).toBe(4);
  });

  it('never marks an asset whose deletion failed (C2 retries it); the others are marked', async () => {
    const h = harness();
    h.sql.purgeBatches = [[purged(1), purged(2)], []];
    h.storage.failPrefix.add(`assets/${asset(1)}/`);
    const result = await purgeStep(OPTIONS).run(h.ctx);
    expect(result).toMatchObject({
      status: 'completed',
      counts: { assets_purged: 2, assets_objects_deleted: 1 },
      s3Failures: 1,
    });
    expect(h.sql.markedObjects).toEqual([asset(2)]);
  });

  it('refuses to delete anything for a source key that does not match the asset', async () => {
    const h = harness();
    const bad = { ...purged(1), sourceKey: `uploads/${OWNER}/${asset(9)}/source` };
    h.sql.purgeBatches = [[bad]];
    const result = await purgeStep(OPTIONS).run(h.ctx);
    expect(h.storage.deletedPrefixes).toEqual([]);
    expect(h.sql.markedObjects).toEqual([]);
    expect(result.s3Failures).toBe(1);
    expect(h.logs[0]).toMatchObject({ level: 'error' });
  });

  it('reports "locked" when the marking transaction cannot take the lock (objects stay unmarked)', async () => {
    const h = harness((n) => n === 0);
    h.sql.purgeBatches = [[purged(1)]];
    const result = await purgeStep(OPTIONS).run(h.ctx);
    expect(result.status).toBe('locked');
    expect(h.sql.markedObjects).toEqual([]);
  });

  it('uploadsPrefixOf derives uploads/{owner}/{asset}/ only from a matching key', () => {
    expect(uploadsPrefixOf(purged(1))).toBe(`uploads/${OWNER}/${asset(1)}/`);
    expect(uploadsPrefixOf({ ...purged(1), ownerId: asset(7) })).toBeNull();
    expect(uploadsPrefixOf({ ...purged(1), sourceKey: 'uploads/../x/source' })).toBeNull();
  });
});

describe('C2. pending object deletions', () => {
  it('retries deletion and marks; a failure ends the step instead of re-reading the same rows', async () => {
    const h = harness();
    const row = (n: number): AssetObjectsToDelete => ({
      id: asset(n),
      ownerId: OWNER,
      sourceKey: sourceKey(asset(n)),
      outputPrefix: null,
    });
    h.sql.pendingBatches = [
      [row(1), row(2)],
      [row(3), row(4)],
    ];
    h.storage.failPrefix.add(`uploads/${OWNER}/${asset(2)}/`);
    const result = await pendingObjectDeletionsStep(OPTIONS).run(h.ctx);
    expect(result).toMatchObject({ counts: { assets_objects_deleted: 1 }, s3Failures: 1 });
    expect(h.sql.calls).toEqual(['findAssetsPendingObjectDeletion']);
    expect(h.sql.markedObjects).toEqual([asset(1)]);
  });
});

describe('D. source retention', () => {
  it('deletes expired READY sources, then marks exactly the deleted ones', async () => {
    const h = harness();
    h.sql.readyBatches = [[source(1), source(2)], [source(3)]];
    const result = await expiredSourcesStep({ ...OPTIONS, sourceRetentionDays: 1 }).run(h.ctx);
    expect(h.sql.readyOptions[0]).toEqual({ retentionDays: 1, batchSize: 2 });
    expect(h.storage.deletedObjects).toEqual([
      `uploads:${sourceKey(asset(1))}`,
      `uploads:${sourceKey(asset(2))}`,
      `uploads:${sourceKey(asset(3))}`,
    ]);
    expect(h.sql.markedSources).toEqual([[asset(1), asset(2)], [asset(3)]]);
    expect(result).toEqual({ status: 'completed', counts: { sources_deleted: 3 }, s3Failures: 0 });
  });

  it('does not mark a source whose S3 delete failed, and stops for this run', async () => {
    const h = harness();
    h.sql.readyBatches = [[source(1), source(2)], [source(3)]];
    h.storage.failDelete.add(sourceKey(asset(1)));
    const result = await expiredSourcesStep(OPTIONS).run(h.ctx);
    expect(h.sql.markedSources).toEqual([[asset(2)]]);
    expect(h.sql.calls).toEqual(['findExpiredReadySources']);
    expect(result).toMatchObject({ counts: { sources_deleted: 1 }, s3Failures: 1 });
  });

  it("D' handles stale FAILED sources the same way", async () => {
    const h = harness();
    h.sql.failedBatches = [[source(4)]];
    const result = await failedSourcesStep(OPTIONS).run(h.ctx);
    expect(h.sql.calls).toEqual(['findStaleFailedSources']);
    expect(h.sql.markedSources).toEqual([[asset(4)]]);
    expect(result.counts.sources_deleted).toBe(1);
  });

  it('never deletes a key outside the uploads layout', async () => {
    const h = harness();
    h.sql.readyBatches = [[{ id: asset(1), sourceKey: 'assets/x/source' }]];
    const result = await expiredSourcesStep(OPTIONS).run(h.ctx);
    expect(h.storage.deletedObjects).toEqual([]);
    expect(h.sql.markedSources).toEqual([]);
    expect(result.s3Failures).toBe(1);
  });
});

describe('mediaCleanupSteps', () => {
  it("runs A, B, C2 (retries), C, D, D' in that order", () => {
    expect(mediaCleanupSteps(OPTIONS).map((s) => s.name)).toEqual([
      'stale_uploads',
      'orphan_multiparts',
      'pending_object_deletions',
      'purge',
      'expired_sources',
      'failed_sources',
    ]);
  });
});
