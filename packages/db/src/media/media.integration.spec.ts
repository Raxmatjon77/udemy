import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetRow, createAsset, createUser, jobRow, PART_SIZE } from '../testing/fixtures';
import {
  backendPid,
  deleteTestData,
  expectFailure,
  rollback,
  signal,
  useIntegrationDb,
  waitUntilBlocked,
} from '../testing/it-db';
import {
  abortStaleUploads,
  findExpiredReadySources,
  findLiveUploadIds,
  markAssetObjectsDeleted,
  markSourcesDeleted,
  purgeUnusedAssets,
} from './cleanup';
import { lockOwnerMediaUsage } from './quota';
import {
  completeTranscodeJob,
  enqueueTranscodeJob,
  failTranscodeJob,
  heartbeatTranscodeJob,
  leaseTranscodeJob,
  reapExpiredTranscodeLeases,
  releaseTranscodeJob,
  TranscodeLeaseLostError,
} from './transcoder';
import { findLeakedUsages } from '../catalog/consistency';
import { deleteAssetUsage, insertAssetUsage, lockAssets, releaseConsumerUsages } from './usages';

/**
 * Media DDL invariants + the §8 operational SQL. Race tests commit real rows (two connections
 * can't see each other's uncommitted data); they belong to users created in beforeAll and are
 * removed in afterAll. Everything else runs in rolled-back transactions.
 *
 * Global statements (lease, purge, cleanup scans) could touch other suites' rows on a shared dev
 * database, so they run either in rolled-back transactions or with thresholds that only match
 * this file's back-dated rows (a 10-year grace vs. rows dated 2000-01-01).
 */
const pg = useIntegrationDb({ max: 8 });
const OLD = new Date('2000-01-01T00:00:00Z');
const TEN_YEARS_H = 24 * 3650;
const LEASE = { workerId: 'it-worker-1', leaseMs: 60_000 };

let ownerId: string;

beforeAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  ownerId = await createUser(pg.db);
});

afterAll(async () => {
  if (pg.unavailableReason !== undefined || ownerId === undefined) return;
  await deleteTestData(pg.db, [ownerId]);
});

/** UPLOADED asset with a QUEUED job whose run_after is back-dated (first in lease order). */
async function queuedJob(ex: Parameters<typeof createAsset>[0], owner: string): Promise<string> {
  const assetId = await createAsset(ex, { ownerId: owner, stage: 'UPLOADED' });
  expect(await enqueueTranscodeJob(ex, assetId)).toBe(true);
  await sql`UPDATE media.transcode_jobs SET run_after = ${OLD} WHERE asset_id = ${assetId}`.execute(
    ex,
  );
  return assetId;
}

describe('media.assets constraints', () => {
  it('illegal transitions and upload-plan mismatches fail', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const ready = await createAsset(trx, { ownerId: owner, stage: 'READY' });
      const back = await expectFailure(trx, () =>
        sql`UPDATE media.assets SET status = 'PROCESSING' WHERE id = ${ready}`.execute(trx),
      );
      expect(back).toMatchObject({ code: '23514', constraint: 'assets_status_transition_ck' });

      const base = (id: string) => ({
        id,
        ownerId: owner,
        purpose: 'LECTURE_VIDEO',
        originalFilename: 'a.mp4',
        declaredContentType: 'video/mp4',
        declaredSizeBytes: '10000000',
        partSizeBytes: PART_SIZE,
        partCount: 2,
        sourceKey: `uploads/${owner}/${id}/source`,
        s3UploadId: 'u',
      });
      const id1 = randomUUID();
      const asReady = await expectFailure(trx, () =>
        trx
          .insertInto('media.assets')
          .values({ ...base(id1), status: 'READY' })
          .execute(),
      );
      expect(asReady).toMatchObject({ code: '23514', constraint: 'assets_status_transition_ck' });

      const id2 = randomUUID();
      const parts = await expectFailure(trx, () =>
        trx
          .insertInto('media.assets')
          .values({ ...base(id2), partCount: 3 })
          .execute(),
      );
      expect(parts).toMatchObject({ code: '23514', constraint: 'assets_part_count_ck' });

      const id3 = randomUUID();
      const key = await expectFailure(trx, () =>
        trx
          .insertInto('media.assets')
          .values({ ...base(id3), sourceKey: `uploads/${owner}/${randomUUID()}/source` })
          .execute(),
      );
      expect(key).toMatchObject({ code: '23514', constraint: 'assets_source_key_ck' });

      // contract alignment: content type regex/length and the 5 TiB cap
      const ct = await expectFailure(trx, () =>
        trx
          .insertInto('media.assets')
          .values({ ...base(randomUUID()), declaredContentType: 'Video/MP4' })
          .execute(),
      );
      expect(ct).toMatchObject({ code: '23514', constraint: 'assets_declared_content_type_ck' });

      // purged_at is final
      await sql`UPDATE media.assets SET purged_at = now() WHERE id = ${ready}`.execute(trx);
      const unpurge = await expectFailure(trx, () =>
        sql`UPDATE media.assets SET purged_at = NULL WHERE id = ${ready}`.execute(trx),
      );
      expect(unpurge).toMatchObject({ code: '23514', constraint: 'assets_immutable_ck' });
    });
  });
});

describe('media.asset_usages', () => {
  it('maintains unused_since/first_used_at and rejects unusable assets and wrong purposes', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const video = await createAsset(trx, { ownerId: owner, stage: 'UPLOADED' });
      expect((await assetRow(trx, video)).unusedSince).not.toBeNull();

      const lecture = randomUUID();
      expect(await lockAssets(trx, [video, video])).toHaveLength(1);
      expect(
        await insertAssetUsage(trx, {
          assetId: video,
          consumerType: 'catalog.lecture',
          consumerId: lecture,
        }),
      ).toBe(true);
      expect(
        await insertAssetUsage(trx, {
          assetId: video,
          consumerType: 'catalog.lecture',
          consumerId: lecture,
        }),
      ).toBe(false);
      const used = await assetRow(trx, video);
      expect(used.unusedSince).toBeNull();
      expect(used.firstUsedAt).not.toBeNull();

      // one working consumer per asset
      const second = await expectFailure(trx, () =>
        insertAssetUsage(trx, {
          assetId: video,
          consumerType: 'catalog.lecture',
          consumerId: randomUUID(),
        }),
      );
      expect(second).toMatchObject({
        code: '23505',
        constraint: 'asset_usages_asset_id_working_uq',
      });

      // revision pins need READY
      const pin = await expectFailure(trx, () =>
        insertAssetUsage(trx, {
          assetId: video,
          consumerType: 'catalog.course_revision',
          consumerId: randomUUID(),
        }),
      );
      expect(pin).toMatchObject({ code: '23514', constraint: 'asset_usages_asset_usable_ck' });

      const purpose = await expectFailure(trx, () =>
        insertAssetUsage(trx, {
          assetId: video,
          consumerType: 'catalog.course_thumbnail',
          consumerId: randomUUID(),
        }),
      );
      expect(purpose).toMatchObject({ code: '23514', constraint: 'asset_usages_purpose_ck' });

      const missing = await expectFailure(trx, () =>
        insertAssetUsage(trx, {
          assetId: randomUUID(),
          consumerType: 'catalog.lecture',
          consumerId: randomUUID(),
        }),
      );
      expect(missing).toMatchObject({ code: '23503', constraint: 'asset_usages_asset_id_fk' });

      const immutable = await expectFailure(trx, () =>
        sql`UPDATE media.asset_usages SET consumer_id = ${randomUUID()} WHERE asset_id = ${video}`.execute(
          trx,
        ),
      );
      expect(immutable).toMatchObject({ code: '23514', constraint: 'asset_usages_immutable_ck' });

      // release -> unused again; releaseConsumer releases every pin of a consumer
      expect(
        await deleteAssetUsage(trx, {
          assetId: video,
          consumerType: 'catalog.lecture',
          consumerId: lecture,
        }),
      ).toBe(true);
      expect((await assetRow(trx, video)).unusedSince).not.toBeNull();

      const r1 = await createAsset(trx, { ownerId: owner, stage: 'READY' });
      const r2 = await createAsset(trx, {
        ownerId: owner,
        purpose: 'COURSE_THUMBNAIL',
        stage: 'READY',
      });
      const revision = randomUUID();
      for (const assetId of [r1, r2]) {
        await insertAssetUsage(trx, {
          assetId,
          consumerType: 'catalog.course_revision',
          consumerId: revision,
        });
      }
      expect(
        await releaseConsumerUsages(trx, {
          consumerType: 'catalog.course_revision',
          consumerId: revision,
        }),
      ).toEqual([r1, r2].sort());
      expect((await assetRow(trx, r1)).unusedSince).not.toBeNull();

      // a leaked pin is reported by the §8.6 drift check
      await insertAssetUsage(trx, {
        assetId: r1,
        consumerType: 'catalog.course_revision',
        consumerId: randomUUID(),
      });
      expect((await findLeakedUsages(trx, { limit: 10_000 })).map((u) => u.assetId)).toContain(r1);
    });
  });

  it('lockAssets / releaseConsumerUsages refuse to run outside a transaction', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await expect(lockAssets(pg.db, [randomUUID()])).rejects.toThrow(/inside a transaction/);
  });
});

describe('purge vs attach races (two connections)', () => {
  it('A holds the asset lock via a usage INSERT; B purges and skips the row', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const asset = await createAsset(pg.db, { ownerId, stage: 'UPLOADED' });
    await sql`UPDATE media.assets SET unused_since = ${OLD} WHERE id = ${asset}`.execute(pg.db);

    const aInserted = signal();
    const bDone = signal();
    const a = pg.db.transaction().execute(async (trx) => {
      await insertAssetUsage(trx, {
        assetId: asset,
        consumerType: 'catalog.lecture',
        consumerId: randomUUID(),
      });
      aInserted.resolve();
      await bDone.promise;
    });
    await aInserted.promise;
    const purged = await rollback(pg.db, (trx) =>
      purgeUnusedAssets(trx, {
        neverUsedGraceHours: TEN_YEARS_H,
        releasedGraceDays: 3650,
        batchSize: 100,
      }),
    );
    bDone.resolve();
    await a;
    expect(purged.map((p) => p.id)).not.toContain(asset); // SKIP LOCKED
    const row = await assetRow(pg.db, asset);
    expect(row.purgedAt).toBeNull();
    expect(row.unusedSince).toBeNull();
  });

  it('B purges and holds; A’s usage INSERT blocks, then fails with asset_usages_asset_usable_ck', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const asset = await createAsset(pg.db, { ownerId, stage: 'UPLOADED' });
    await sql`UPDATE media.assets SET unused_since = ${OLD} WHERE id = ${asset}`.execute(pg.db);

    const bPurged = signal();
    const aBlocked = signal();
    let foreign: string[] = [];
    const b = pg.db.transaction().execute(async (trx) => {
      const purged = await purgeUnusedAssets(trx, {
        neverUsedGraceHours: TEN_YEARS_H,
        releasedGraceDays: 3650,
        batchSize: 100,
      });
      foreign = purged.map((p) => p.id).filter((id) => id !== asset);
      // never commit a purge of rows that are not ours (shared dev database)
      if (foreign.length > 0)
        throw new Error(`refusing to purge foreign assets ${foreign.join(',')}`);
      expect(purged.map((p) => p.id)).toEqual([asset]);
      bPurged.resolve();
      await aBlocked.promise;
    });
    await bPurged.promise;

    const a = pg.db.transaction().execute(async (trx) => {
      const pid = await backendPid(trx);
      const insert = insertAssetUsage(trx, {
        assetId: asset,
        consumerType: 'catalog.lecture',
        consumerId: randomUUID(),
      });
      await waitUntilBlocked(pg.db, pid);
      aBlocked.resolve();
      return insert;
    });
    await b;
    const error = await a.then(
      () => undefined,
      (e: unknown) => e as { code?: string; constraint?: string },
    );
    expect(error).toMatchObject({ code: '23514', constraint: 'asset_usages_asset_usable_ck' });
    expect((await assetRow(pg.db, asset)).purgedAt).not.toBeNull();
  });

  it('concurrent release of the last two usages leaves unused_since NOT NULL', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const asset = await createAsset(pg.db, { ownerId, stage: 'READY' });
    const pins = [randomUUID(), randomUUID()];
    for (const consumerId of pins) {
      await insertAssetUsage(pg.db, {
        assetId: asset,
        consumerType: 'catalog.course_revision',
        consumerId,
      });
    }
    expect((await assetRow(pg.db, asset)).unusedSince).toBeNull();

    const t1Deleted = signal();
    const t2Blocked = signal();
    const t1 = pg.db.transaction().execute(async (trx) => {
      await deleteAssetUsage(trx, {
        assetId: asset,
        consumerType: 'catalog.course_revision',
        consumerId: pins[0]!,
      });
      t1Deleted.resolve();
      await t2Blocked.promise;
    });
    await t1Deleted.promise;
    const t2 = pg.db.transaction().execute(async (trx) => {
      const pid = await backendPid(trx);
      const del = deleteAssetUsage(trx, {
        assetId: asset,
        consumerType: 'catalog.course_revision',
        consumerId: pins[1]!,
      });
      await waitUntilBlocked(pg.db, pid); // its AFTER trigger waits for T1's asset lock
      t2Blocked.resolve();
      return del;
    });
    await Promise.all([t1, t2]);
    const row = await assetRow(pg.db, asset);
    expect(row.unusedSince).not.toBeNull();
    expect(
      await pg.db
        .selectFrom('media.assetUsages')
        .select('assetId')
        .where('assetId', '=', asset)
        .execute(),
    ).toEqual([]);
  });
});

describe('transcoder (§8.1)', () => {
  it('two connections lease distinct jobs with SKIP LOCKED', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const j1 = await queuedJob(pg.db, ownerId);
    const j2 = await queuedJob(pg.db, ownerId);
    const leased: string[] = [];
    const firstLeased = signal();
    const secondDone = signal();
    // both transactions roll back: nothing (ours or foreign) is leased for real
    const t1 = rollback(pg.db, async (trx) => {
      const lease = await leaseTranscodeJob(trx, LEASE);
      leased.push(lease?.assetId ?? 'none');
      firstLeased.resolve();
      await secondDone.promise;
    });
    await firstLeased.promise;
    await rollback(pg.db, async (trx) => {
      const lease = await leaseTranscodeJob(trx, { ...LEASE, workerId: 'it-worker-2' });
      leased.push(lease?.assetId ?? 'none');
    });
    secondDone.resolve();
    await t1;
    // retire the committed jobs so later leases in this file never pick them
    await sql`
      UPDATE media.transcode_jobs SET status = 'CANCELLED', finished_at = now()
       WHERE asset_id IN (${j1}, ${j2}) AND status = 'QUEUED'
    `.execute(pg.db);
    expect(new Set(leased).size).toBe(2);
    expect([...leased].sort()).toEqual([j1, j2].sort());
  });

  it('lease -> heartbeat (stale lease_count updates 0 rows) -> complete; complete twice is lease-lost', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const assetId = await queuedJob(trx, owner);
      const lease = await leaseTranscodeJob(trx, LEASE);
      expect(lease).toMatchObject({
        kind: 'leased',
        assetId,
        leaseNo: 1,
        attempts: 1,
        maxAttempts: 3,
      });
      expect((await assetRow(trx, assetId)).status).toBe('PROCESSING');
      const fence = { assetId, workerId: LEASE.workerId, leaseNo: 1 };

      expect(
        await heartbeatTranscodeJob(trx, { ...fence, leaseNo: 2, leaseMs: 60_000 }),
      ).toBeNull();
      expect(
        await heartbeatTranscodeJob(trx, { ...fence, workerId: 'someone-else', leaseMs: 60_000 }),
      ).toBeNull();
      expect(
        await heartbeatTranscodeJob(trx, { ...fence, leaseMs: 60_000, progressPct: 40 }),
      ).toBeInstanceOf(Date);
      await heartbeatTranscodeJob(trx, { ...fence, leaseMs: 60_000, progressPct: 10 });
      expect((await jobRow(trx, assetId)).progressPct).toBe(40); // never backwards

      // a second open attempt is impossible
      const open = await expectFailure(trx, () =>
        sql`INSERT INTO media.transcode_attempts (asset_id, attempt_no, worker_id) VALUES (${assetId}, 2, 'x')`.execute(
          trx,
        ),
      );
      expect(open).toMatchObject({
        code: '23505',
        constraint: 'transcode_attempts_asset_id_open_uq',
      });

      const done = await completeTranscodeJob(trx, {
        ...fence,
        durationMs: 61_000,
        width: 1920,
        height: 1080,
        detectedFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
        renditions: [
          {
            name: '720p',
            kind: 'HLS_VARIANT',
            width: 1280,
            height: 720,
            bandwidthBps: 2_800_000,
            codecs: 'avc1.64001f,mp4a.40.2',
            objectKey: `assets/${assetId}/a1/720p/index.m3u8`,
          },
          {
            name: 'poster',
            kind: 'IMAGE',
            width: 1280,
            height: 720,
            bandwidthBps: null,
            codecs: null,
            objectKey: `assets/${assetId}/a1/poster.jpg`,
          },
        ],
      });
      expect(done).toMatchObject({
        id: assetId,
        outputPrefix: `assets/${assetId}/a1/`,
        durationMs: 61_000,
      });
      expect((await jobRow(trx, assetId)).status).toBe('SUCCEEDED');

      await sql`SAVEPOINT again`.execute(trx);
      await expect(
        completeTranscodeJob(trx, {
          ...fence,
          durationMs: 1,
          width: 1,
          height: 1,
          detectedFormat: null,
          renditions: [],
        }),
      ).rejects.toBeInstanceOf(TranscodeLeaseLostError);
      await sql`ROLLBACK TO SAVEPOINT again`.execute(trx);

      // an attempt can only be finished once; never deleted
      const refinish = await expectFailure(trx, () =>
        sql`UPDATE media.transcode_attempts SET outcome = 'FAILED', error_code = 'INTERNAL' WHERE asset_id = ${assetId}`.execute(
          trx,
        ),
      );
      expect(refinish.code).toBe('42501');
      const del = await expectFailure(trx, () =>
        sql`DELETE FROM media.transcode_attempts WHERE asset_id = ${assetId}`.execute(trx),
      );
      expect(del.code).toBe('42501');
      const renditionUpdate = await expectFailure(trx, () =>
        sql`UPDATE media.asset_renditions SET width = 1 WHERE asset_id = ${assetId}`.execute(trx),
      );
      expect(renditionUpdate.code).toBe('42501');
    });
  });

  it('retryable failures requeue with backoff, then go terminal; release is not penalised', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const assetId = await queuedJob(trx, owner);

      const l1 = await leaseTranscodeJob(trx, LEASE);
      expect(l1).toMatchObject({ kind: 'leased', assetId, leaseNo: 1 });
      expect(
        await releaseTranscodeJob(trx, { assetId, workerId: LEASE.workerId, leaseNo: 1 }),
      ).toBe(true);
      expect(
        await releaseTranscodeJob(trx, { assetId, workerId: LEASE.workerId, leaseNo: 1 }),
      ).toBe(false);
      expect(await jobRow(trx, assetId)).toMatchObject({
        status: 'QUEUED',
        attempts: 0,
        leaseCount: 1,
      });
      await sql`UPDATE media.transcode_jobs SET run_after = ${OLD} WHERE asset_id = ${assetId}`.execute(
        trx,
      );

      for (let leaseNo = 2; leaseNo <= 4; leaseNo++) {
        const lease = await leaseTranscodeJob(trx, LEASE);
        expect(lease).toMatchObject({ kind: 'leased', assetId, leaseNo });
        const result = await failTranscodeJob(trx, {
          assetId,
          workerId: LEASE.workerId,
          leaseNo,
          code: 'TRANSCODE_ERROR',
          detail: 'ffmpeg exit 1',
          retryable: true,
        });
        if (leaseNo < 4) {
          expect(result.outcome).toBe('RETRY');
          await sql`UPDATE media.transcode_jobs SET run_after = ${OLD} WHERE asset_id = ${assetId}`.execute(
            trx,
          );
        } else {
          expect(result).toMatchObject({
            outcome: 'FAILED',
            attempts: 3,
            asset: { ownerId: owner, purpose: 'LECTURE_VIDEO' },
          });
        }
      }
      expect(await assetRow(trx, assetId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'TRANSCODE_ERROR',
      });
      const outcomes = await trx
        .selectFrom('media.transcodeAttempts')
        .select(['attemptNo', 'outcome'])
        .where('assetId', '=', assetId)
        .orderBy('attemptNo')
        .execute();
      expect(outcomes.map((o) => o.outcome)).toEqual(['RELEASED', 'RETRY', 'RETRY', 'FAILED']);
      expect(await markSourcesDeleted(trx, [assetId])).toBe(1);
      expect(await markSourcesDeleted(trx, [assetId])).toBe(0);
    });
  });

  it('the reaper requeues expired leases and fails them terminally when attempts are exhausted', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const assetId = await queuedJob(trx, owner);
      await sql`UPDATE media.transcode_jobs SET max_attempts = 2 WHERE asset_id = ${assetId}`.execute(
        trx,
      );
      const expire = () =>
        sql`UPDATE media.transcode_jobs SET lease_expires_at = ${OLD} WHERE asset_id = ${assetId}`.execute(
          trx,
        );

      await leaseTranscodeJob(trx, LEASE);
      await expire();
      const r1 = await reapExpiredTranscodeLeases(trx, { batchSize: 1000 });
      expect(r1).toContainEqual({ assetId, leaseNo: 1, outcome: 'REQUEUED' });
      await sql`UPDATE media.transcode_jobs SET run_after = ${OLD} WHERE asset_id = ${assetId}`.execute(
        trx,
      );

      await leaseTranscodeJob(trx, LEASE);
      await expire();
      const r2 = await reapExpiredTranscodeLeases(trx, { batchSize: 1000 });
      expect(r2).toContainEqual({
        assetId,
        leaseNo: 2,
        outcome: 'FAILED',
        attempts: 2,
        asset: expect.objectContaining({ ownerId: owner }),
      });
      expect(await assetRow(trx, assetId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'CRASHED',
      });
      const attempts = await trx
        .selectFrom('media.transcodeAttempts')
        .select(['outcome', 'errorCode'])
        .where('assetId', '=', assetId)
        .execute();
      expect(attempts).toEqual([
        { outcome: 'LEASE_LOST', errorCode: 'CRASHED' },
        { outcome: 'LEASE_LOST', errorCode: 'CRASHED' },
      ]);
    });
  });

  it('a lease finding a purged asset cancels the job; enqueue is idempotent and skips non-UPLOADED assets', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const assetId = await queuedJob(trx, owner);
      expect(await enqueueTranscodeJob(trx, assetId)).toBe(false);
      const uploading = await createAsset(trx, { ownerId: owner, stage: 'UPLOADING' });
      expect(await enqueueTranscodeJob(trx, uploading)).toBe(false);

      await sql`UPDATE media.assets SET purged_at = now() WHERE id = ${assetId}`.execute(trx);
      const lease = await leaseTranscodeJob(trx, LEASE);
      expect(lease).toEqual({ kind: 'cancelled', assetId, leaseNo: 1 });
      expect(await jobRow(trx, assetId)).toMatchObject({ status: 'CANCELLED', leaseOwner: null });
    });
  });
});

describe('cleanup (§8.2) and quota (§8.4)', () => {
  it('A aborts stale uploads returning the old UploadId; B finds live upload ids', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const stale = await createAsset(trx, { ownerId: owner, stage: 'UPLOADING', createdAt: OLD });
      const fresh = await createAsset(trx, { ownerId: owner, stage: 'UPLOADING' });
      expect(await findLiveUploadIds(trx, [`it-upload-${stale}`, 'it-upload-unknown'])).toEqual(
        new Set([`it-upload-${stale}`]),
      );

      const aborted = await abortStaleUploads(trx, { ttlHours: TEN_YEARS_H, batchSize: 1000 });
      expect(aborted).toContainEqual({
        id: stale,
        sourceKey: `uploads/${owner}/${stale}/source`,
        s3UploadId: `it-upload-${stale}`,
      });
      expect(aborted.map((a) => a.id)).not.toContain(fresh);
      expect(await assetRow(trx, stale)).toMatchObject({ status: 'ABORTED', s3UploadId: null });
    });
  });

  it('C purges only unused assets past their grace and never one with a queued job; D finds expired sources', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      const unused = await createAsset(trx, { ownerId: owner, stage: 'READY' });
      const withJob = await queuedJob(trx, owner);
      const recent = await createAsset(trx, { ownerId: owner, stage: 'UPLOADED' });
      await sql`UPDATE media.assets SET unused_since = ${OLD} WHERE id IN (${unused}, ${withJob})`.execute(
        trx,
      );
      await sql`UPDATE media.assets SET ready_at = ${OLD} WHERE id = ${unused}`.execute(trx);

      expect(
        (await findExpiredReadySources(trx, { retentionDays: 3650, batchSize: 1000 })).map(
          (s) => s.id,
        ),
      ).toContain(unused);

      const purged = await purgeUnusedAssets(trx, {
        neverUsedGraceHours: TEN_YEARS_H,
        releasedGraceDays: 3650,
        batchSize: 1000,
      });
      const ids = purged.map((p) => p.id);
      expect(ids).toContain(unused);
      expect(ids).not.toContain(withJob);
      expect(ids).not.toContain(recent);
      expect(purged.find((p) => p.id === unused)).toMatchObject({
        ownerId: owner,
        status: 'READY',
        outputPrefix: `assets/${unused}/a1/`,
      });

      const attach = await expectFailure(trx, () =>
        insertAssetUsage(trx, {
          assetId: unused,
          consumerType: 'catalog.lecture',
          consumerId: randomUUID(),
        }),
      );
      expect(attach).toMatchObject({ constraint: 'asset_usages_asset_usable_ck' });
      expect(await markAssetObjectsDeleted(trx, unused)).toBe(true);
      expect(await markAssetObjectsDeleted(trx, unused)).toBe(false);
      expect((await assetRow(trx, unused)).sourceDeletedAt).not.toBeNull();
    });
  });

  it('quota sums non-purged active assets under the per-owner advisory lock', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await expect(lockOwnerMediaUsage(pg.db, randomUUID())).rejects.toThrow(/inside a transaction/);
    await rollback(pg.db, async (trx) => {
      const owner = await createUser(trx);
      await createAsset(trx, { ownerId: owner, stage: 'UPLOADING' });
      await createAsset(trx, { ownerId: owner, stage: 'READY' });
      const purged = await createAsset(trx, { ownerId: owner, stage: 'READY' });
      await sql`UPDATE media.assets SET purged_at = now() WHERE id = ${purged}`.execute(trx);
      expect(await lockOwnerMediaUsage(trx, owner)).toEqual({
        usedBytes: '20000000',
        uploading: 1,
      });
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = 1836151905
      `.execute(trx);
      expect(rows[0]!.n).toBe(1);
    });
  });
});
