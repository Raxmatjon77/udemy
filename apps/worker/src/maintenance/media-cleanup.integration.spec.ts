import { randomUUID } from 'node:crypto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MediaPurged } from '@udemy/contracts';
import { sql } from '@udemy/db';
import { useIntegrationS3 } from '@udemy/storage/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerConfigService } from '../shared/config';
import type { WorkerEnv } from '../shared/config/worker-env.schema';
import { deleteTestData, insertTestUser, useIntegrationStack } from '../testing/integration';
import { MEDIA_CLEANUP_LOCK_KEY, MediaCleanupJob } from './media-cleanup.job';
import { type MediaCleanupOptions, mediaCleanupSteps } from './media-cleanup.steps';

/**
 * MediaCleanupJob A-D against the dev Postgres and the dev MinIO, with real multipart uploads
 * and objects.
 *
 * Isolation in shared dev infrastructure:
 * - The DB statements are global, so every seeded row is backdated ~3000 days and the graces
 *   are 2900 days: only these rows qualify (nothing created by people or other tests does).
 * - Step B lists only `uploads/{this file's owner}/` (the `uploadsPrefix` option), so other
 *   in-flight multipart uploads in MinIO are never touched.
 * - The two steps with hard-coded global windows (C2: purged > 10 min ago; D': FAILED > 1 h
 *   ago) are left out here and covered by the unit tests.
 * - Every key contains this file's fresh owner/asset UUIDs; afterAll empties those prefixes and
 *   deletes the rows (replica-mode cleanup).
 */
const OLD_DAYS = 3000;
const GRACE_DAYS = 2900;
const MiB = 1024 * 1024;

const CONFIG: Partial<WorkerEnv> = { MEDIA_CLEANUP_MAX_BATCHES_PER_RUN: 20 };
const config = {
  get: <K extends keyof WorkerEnv>(key: K): WorkerEnv[K] => CONFIG[key] as WorkerEnv[K],
} as WorkerConfigService;

describe('MediaCleanupJob (integration: Postgres + MinIO)', () => {
  const it_ = useIntegrationStack();
  const s3 = useIntegrationS3();
  const userIds: string[] = [];
  let ownerId = '';
  let options: MediaCleanupOptions;

  beforeAll(async () => {
    if (it_.unavailableReason !== undefined || s3.unavailableReason !== undefined) return;
    ownerId = (await insertTestUser(it_.db, { tag: 'media-cleanup', role: 'INSTRUCTOR' })).id;
    userIds.push(ownerId);
    s3.cleanupPrefix('uploads', `uploads/${ownerId}/`);
    options = {
      batchSize: 2,
      uploadTtlHours: GRACE_DAYS * 24,
      neverUsedGraceHours: GRACE_DAYS * 24,
      releasedGraceDays: GRACE_DAYS,
      sourceRetentionDays: GRACE_DAYS,
      orphanMultipartMinAgeHours: 0,
      uploadsPrefix: `uploads/${ownerId}/`,
    };
  });

  afterAll(async () => {
    if (it_.unavailableReason !== undefined) return;
    await deleteTestData(it_.db, userIds);
  });

  const steps = () =>
    mediaCleanupSteps(options).filter(
      (s) => s.name !== 'pending_object_deletions' && s.name !== 'failed_sources',
    );
  const newJob = () => new MediaCleanupJob(it_.db, s3.storage, config, new SchedulerRegistry());
  const sourceKeyOf = (assetId: string) => `uploads/${ownerId}/${assetId}/source`;
  const daysAgo = (days: number) => sql<Date>`now() - make_interval(days => ${days}::int)`;

  async function startMultipart(assetId: string): Promise<string> {
    const { uploadId } = await s3.storage.createMultipartUpload({
      bucket: 'uploads',
      key: sourceKeyOf(assetId),
      contentType: 'application/pdf',
    });
    return uploadId;
  }

  async function liveUploadIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for await (const u of s3.storage.listMultipartUploads({
      bucket: 'uploads',
      prefix: `uploads/${ownerId}/`,
    })) {
      ids.add(u.uploadId);
    }
    return ids;
  }

  /** UPLOADING row backed by a real multipart upload, created `createdDaysAgo` days ago. */
  async function seedUploading(createdDaysAgo: number): Promise<{ id: string; uploadId: string }> {
    const id = randomUUID();
    const uploadId = await startMultipart(id);
    s3.cleanupPrefix('media', `assets/${id}/`);
    await it_.db
      .insertInto('media.assets')
      .values({
        id,
        ownerId,
        purpose: 'LECTURE_RESOURCE',
        originalFilename: 'notes.pdf',
        declaredContentType: 'application/pdf',
        declaredSizeBytes: '1000',
        partSizeBytes: 8 * MiB,
        partCount: 1,
        sourceKey: sourceKeyOf(id),
        s3UploadId: uploadId,
        createdAt: daysAgo(createdDaysAgo),
        unusedSince: daysAgo(createdDaysAgo),
      })
      .execute();
    return { id, uploadId };
  }

  /**
   * READY LECTURE_RESOURCE (walked through the legal edges) with a source object and two output
   * versions in MinIO. `readyDaysAgo` backdates ready_at; `used` attaches it to a lecture id.
   */
  async function seedReady(o: { readyDaysAgo: number; used: boolean }): Promise<string> {
    const id = randomUUID();
    s3.cleanupPrefix('media', `assets/${id}/`);
    await it_.db
      .insertInto('media.assets')
      .values({
        id,
        ownerId,
        purpose: 'LECTURE_RESOURCE',
        originalFilename: 'notes.pdf',
        declaredContentType: 'application/pdf',
        declaredSizeBytes: '1000',
        partSizeBytes: 8 * MiB,
        partCount: 1,
        sourceKey: sourceKeyOf(id),
        s3UploadId: `it-${id}`,
        createdAt: daysAgo(OLD_DAYS),
        unusedSince: daysAgo(OLD_DAYS),
      })
      .execute();
    await sql`UPDATE media.assets SET status = 'UPLOADED', s3_upload_id = NULL, uploaded_at = now() WHERE id = ${id}`.execute(
      it_.db,
    );
    await sql`UPDATE media.assets SET status = 'PROCESSING' WHERE id = ${id}`.execute(it_.db);
    await sql`
      UPDATE media.assets SET status = 'READY', output_prefix = ${`assets/${id}/a2/`},
             ready_at = now() - make_interval(days => ${o.readyDaysAgo}::int)
       WHERE id = ${id}
    `.execute(it_.db);
    if (o.used) {
      await it_.db
        .insertInto('media.assetUsages')
        .values({ assetId: id, consumerType: 'catalog.lecture', consumerId: randomUUID() })
        .execute();
    }
    const put = (bucket: 'uploads' | 'media', key: string) =>
      s3.storage.putObject({
        bucket,
        key,
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      });
    await put('uploads', sourceKeyOf(id));
    await put('media', `assets/${id}/a1/partial`);
    await put('media', `assets/${id}/a2/resource`);
    return id;
  }

  const asset = (id: string) =>
    it_.db.selectFrom('media.assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const exists = async (bucket: 'uploads' | 'media', key: string) =>
    (await s3.storage.headObject({ bucket, key })) !== null;

  it('does nothing while another replica holds the advisory lock', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    s3.skipIfUnavailable(ctx);
    const staleUpload = await seedUploading(OLD_DAYS);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const otherReplica = it_.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${MEDIA_CLEANUP_LOCK_KEY}::bigint)`.execute(trx);
      locked();
      await held;
    });
    await lockTaken;
    try {
      const result = await newJob().runOnce(steps());
      expect(result.status).toBe('locked');
      expect((await asset(staleUpload.id)).status).toBe('UPLOADING');
      expect(await liveUploadIds()).toContain(staleUpload.uploadId);
    } finally {
      release();
      await otherReplica;
    }
  }, 60_000);

  it('A-D: aborts stale and orphan uploads, purges the unused asset, deletes expired sources, keeps the rest', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    s3.skipIfUnavailable(ctx);
    // A: stale UPLOADING (3000 days) vs a fresh one; both have real multipart uploads.
    const stale = await seedUploading(OLD_DAYS);
    const fresh = await seedUploading(0);
    // B: a multipart upload with no row at all.
    const orphanUploadId = await startMultipart(randomUUID());
    // C: never attached, past the grace -> purged; attached -> untouched.
    const unused = await seedReady({ readyDaysAgo: 1, used: false });
    const inUse = await seedReady({ readyDaysAgo: 1, used: true });
    // D: READY long ago (attached, so not purged) vs inside the retention window.
    const expired = await seedReady({ readyDaysAgo: OLD_DAYS, used: true });
    const retained = await seedReady({ readyDaysAgo: GRACE_DAYS - 10, used: true });

    const result = await newJob().runOnce(steps());
    expect(result.status).toBe('completed');
    expect(result.s3Failures).toBe(0);

    // A
    const staleRow = await asset(stale.id);
    expect(staleRow).toMatchObject({ status: 'ABORTED', s3UploadId: null });
    expect((await asset(fresh.id)).status).toBe('UPLOADING');
    // B (and A's S3 abort): only the fresh, live upload is left under this owner.
    const remaining = await liveUploadIds();
    expect(remaining.has(stale.uploadId)).toBe(false);
    expect(remaining.has(orphanUploadId)).toBe(false);
    expect(remaining.has(fresh.uploadId)).toBe(true);
    expect(result.counts['orphan_multiparts.multiparts_aborted']).toBeGreaterThanOrEqual(1);

    // C: the unused asset is purged, all its objects are gone, and MediaPurged was written.
    const unusedRow = await asset(unused);
    expect(unusedRow.purgedAt).not.toBeNull();
    expect(unusedRow.objectsDeletedAt).not.toBeNull();
    expect(unusedRow.sourceDeletedAt).not.toBeNull();
    expect(await exists('uploads', sourceKeyOf(unused))).toBe(false);
    expect(await exists('media', `assets/${unused}/a1/partial`)).toBe(false);
    expect(await exists('media', `assets/${unused}/a2/resource`)).toBe(false);
    const purgedEvent = await it_.db
      .selectFrom('outbox.events')
      .select(['type', 'payload', 'aggregateType'])
      .where('aggregateId', '=', unused)
      .executeTakeFirstOrThrow();
    expect(purgedEvent).toMatchObject({
      type: MediaPurged.qualifiedType,
      aggregateType: 'media.asset',
      payload: { assetId: unused, ownerId },
    });
    expect(MediaPurged.safeParsePayload(purgedEvent.payload).success).toBe(true);
    // The stale ABORTED asset is unused but its unused_since is 3000 days old too: purged.
    expect(staleRow.purgedAt).not.toBeNull();

    // C: the attached asset is untouched (row and objects).
    const inUseRow = await asset(inUse);
    expect(inUseRow).toMatchObject({
      purgedAt: null,
      sourceDeletedAt: null,
      objectsDeletedAt: null,
    });
    expect(await exists('uploads', sourceKeyOf(inUse))).toBe(true);
    expect(await exists('media', `assets/${inUse}/a2/resource`)).toBe(true);

    // D: the expired source is deleted and marked; outputs stay. Inside retention: kept.
    const expiredRow = await asset(expired);
    expect(expiredRow).toMatchObject({ purgedAt: null });
    expect(expiredRow.sourceDeletedAt).not.toBeNull();
    expect(await exists('uploads', sourceKeyOf(expired))).toBe(false);
    expect(await exists('media', `assets/${expired}/a2/resource`)).toBe(true);
    expect((await asset(retained)).sourceDeletedAt).toBeNull();
    expect(await exists('uploads', sourceKeyOf(retained))).toBe(true);

    // A second run finds nothing left to do for these rows.
    const again = await newJob().runOnce(steps());
    expect(again.status).toBe('completed');
    expect((await asset(fresh.id)).status).toBe('UPLOADING');
    expect((await asset(retained)).sourceDeletedAt).toBeNull();
  }, 120_000);
});
