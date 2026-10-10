/**
 * MediaCleanupJob SQL (docs/phase-2-schema-design.md §8.2), for the worker (T13).
 *
 * Each function runs ONE batch. The caller loops until a batch returns fewer rows than
 * `batchSize`, gives each batch its own transaction guarded by
 * `pg_try_advisory_xact_lock(0x75646d79_02)` (the lock key lives with the worker job, like the
 * identity cleanup), and talks to S3 only AFTER COMMIT (or with no transaction open).
 */
import { sql } from 'kysely';
import { assertBatchSize, assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';

// ------------------------------------------------------------------- A. stale UPLOADING

export interface AbortedUpload {
  id: string;
  sourceKey: string;
  /** The UploadId before it was cleared (PG 18 `RETURNING old.`): abort it in S3 after COMMIT. */
  s3UploadId: string;
}

/** A: UPLOADING older than `ttlHours` -> ABORTED (SKIP LOCKED). */
export async function abortStaleUploads(
  executor: Executor,
  options: { ttlHours: number; batchSize: number },
): Promise<AbortedUpload[]> {
  assertIntInRange('ttlHours', options.ttlHours, 1, 24 * 3650);
  assertBatchSize(options.batchSize);
  const { rows } = await sql<AbortedUpload>`
    WITH doomed AS (
      SELECT id FROM media.assets
       WHERE status = 'UPLOADING' AND created_at < now() - make_interval(hours => ${options.ttlHours}::int)
       ORDER BY created_at LIMIT ${options.batchSize}
       FOR UPDATE SKIP LOCKED)
    UPDATE media.assets a SET status = 'ABORTED', s3_upload_id = NULL
      FROM doomed WHERE a.id = doomed.id AND a.status = 'UPLOADING'
    RETURNING a.id, a.source_key, old.s3_upload_id AS s3_upload_id
  `.execute(executor);
  return rows;
}

// ------------------------------------------------------------- B. orphan S3 multipart uploads

/**
 * B: of the UploadIds S3 lists (initiated > 24 h ago), returns those that still belong to an
 * UPLOADING asset. Abort every listed UploadId NOT in the result.
 */
export async function findLiveUploadIds(
  executor: Executor,
  uploadIds: readonly string[],
): Promise<Set<string>> {
  if (uploadIds.length === 0) return new Set();
  const { rows } = await sql<{ s3UploadId: string }>`
    SELECT s3_upload_id FROM media.assets WHERE s3_upload_id = ANY(${[...uploadIds]}::text[])
  `.execute(executor);
  return new Set(rows.map((r) => r.s3UploadId));
}

// ------------------------------------------------------------------------------- C. purge

export interface PurgedAsset {
  id: string;
  ownerId: string;
  sourceKey: string;
  outputPrefix: string | null;
  status: string;
}

export interface PurgeOptions {
  /** Grace for never-attached assets (MEDIA_UNATTACHED_GRACE_HOURS, e.g. 24). */
  neverUsedGraceHours: number;
  /** Grace after the last usage went away (e.g. 7). */
  releasedGraceDays: number;
  batchSize: number;
}

/**
 * C: sets purged_at on unused assets past their grace period. Assets with a QUEUED/RUNNING job
 * are skipped (no job lock is taken: avoids a lock-order cycle with the lease). The final filter
 * is on columns of the locked row itself, so READ COMMITTED's EvalPlanQual re-check is exact;
 * `NOT EXISTS usages` is belt and braces. In the same transaction emit MediaPurged per row;
 * after COMMIT delete `uploads/{owner}/{id}/` and the output prefix, then call
 * markAssetObjectsDeleted().
 */
export async function purgeUnusedAssets(
  executor: Executor,
  options: PurgeOptions,
): Promise<PurgedAsset[]> {
  assertIntInRange('neverUsedGraceHours', options.neverUsedGraceHours, 0, 24 * 3650);
  assertIntInRange('releasedGraceDays', options.releasedGraceDays, 0, 3650);
  assertBatchSize(options.batchSize);
  const { neverUsedGraceHours: h, releasedGraceDays: d, batchSize } = options;
  // The sargable lower bound uses the smaller of the two graces, so it never excludes a candidate.
  const { rows } = await sql<PurgedAsset>`
    WITH doomed AS (
      SELECT a.id FROM media.assets a
       WHERE a.purged_at IS NULL AND a.unused_since IS NOT NULL
         AND a.unused_since < now() - LEAST(make_interval(hours => ${h}::int), make_interval(days => ${d}::int))
         AND a.unused_since < now() - CASE WHEN a.first_used_at IS NULL
                                           THEN make_interval(hours => ${h}::int)
                                           ELSE make_interval(days  => ${d}::int) END
         AND a.status IN ('UPLOADED','READY','FAILED','ABORTED')
         AND NOT EXISTS (SELECT 1 FROM media.transcode_jobs j
                          WHERE j.asset_id = a.id AND j.status IN ('QUEUED','RUNNING'))
       ORDER BY a.unused_since LIMIT ${batchSize}
       FOR UPDATE OF a SKIP LOCKED)
    UPDATE media.assets a SET purged_at = now()
      FROM doomed
     WHERE a.id = doomed.id AND a.purged_at IS NULL AND a.unused_since IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM media.asset_usages u WHERE u.asset_id = a.id)
    RETURNING a.id, a.owner_id, a.source_key, a.output_prefix, a.status
  `.execute(executor);
  return rows;
}

/** After both prefixes were deleted from S3. Returns false if already marked. */
export async function markAssetObjectsDeleted(
  executor: Executor,
  assetId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE media.assets SET objects_deleted_at = now(), source_deleted_at = coalesce(source_deleted_at, now())
     WHERE id = ${assetId} AND objects_deleted_at IS NULL
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

export interface AssetObjectsToDelete {
  id: string;
  ownerId: string;
  sourceKey: string;
  outputPrefix: string | null;
}

/** C2: purged > 10 minutes ago whose objects are not confirmed deleted yet (retry). */
export async function findAssetsPendingObjectDeletion(
  executor: Executor,
  options: { batchSize: number },
): Promise<AssetObjectsToDelete[]> {
  assertBatchSize(options.batchSize);
  const { rows } = await sql<AssetObjectsToDelete>`
    SELECT id, owner_id, source_key, output_prefix FROM media.assets
     WHERE purged_at IS NOT NULL AND objects_deleted_at IS NULL AND purged_at < now() - interval '10 minutes'
     ORDER BY purged_at LIMIT ${options.batchSize}
  `.execute(executor);
  return rows;
}

// --------------------------------------------------------------------- D. source retention

export interface SourceToDelete {
  id: string;
  sourceKey: string;
}

/** D: READY sources older than `retentionDays` (MEDIA_SOURCE_RETENTION_DAYS: 7; 1 in dev). */
export async function findExpiredReadySources(
  executor: Executor,
  options: { retentionDays: number; batchSize: number },
): Promise<SourceToDelete[]> {
  assertIntInRange('retentionDays', options.retentionDays, 0, 3650);
  assertBatchSize(options.batchSize);
  const { rows } = await sql<SourceToDelete>`
    SELECT id, source_key FROM media.assets
     WHERE status = 'READY' AND source_deleted_at IS NULL AND purged_at IS NULL
       AND ready_at < now() - make_interval(days => ${options.retentionDays}::int)
     ORDER BY ready_at LIMIT ${options.batchSize}
  `.execute(executor);
  return rows;
}

/** D': FAILED sources older than 1 hour (backstop; the transcoder normally deletes at once). */
export async function findStaleFailedSources(
  executor: Executor,
  options: { batchSize: number },
): Promise<SourceToDelete[]> {
  assertBatchSize(options.batchSize);
  const { rows } = await sql<SourceToDelete>`
    SELECT id, source_key FROM media.assets
     WHERE status = 'FAILED' AND source_deleted_at IS NULL AND purged_at IS NULL
       AND failed_at < now() - interval '1 hour'
     ORDER BY failed_at LIMIT ${options.batchSize}
  `.execute(executor);
  return rows;
}

/** After storage.delete(source_key) (idempotent). Returns the number of rows marked. */
export async function markSourcesDeleted(
  executor: Executor,
  assetIds: readonly string[],
): Promise<number> {
  if (assetIds.length === 0) return 0;
  const result = await sql`
    UPDATE media.assets SET source_deleted_at = now()
     WHERE id = ANY(${[...assetIds]}::uuid[]) AND source_deleted_at IS NULL
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n);
}
