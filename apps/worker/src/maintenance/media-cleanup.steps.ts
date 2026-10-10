import { MediaPurged } from '@udemy/contracts';
import {
  type AbortedUpload,
  abortStaleUploads,
  type AssetObjectsToDelete,
  type DB,
  findAssetsPendingObjectDeletion,
  findExpiredReadySources,
  findLiveUploadIds,
  findStaleFailedSources,
  insertOutboxEvent,
  markAssetObjectsDeleted,
  markSourcesDeleted,
  type PurgedAsset,
  type PurgeOptions,
  purgeUnusedAssets,
  type SourceToDelete,
  sql,
  type Transaction,
} from '@udemy/db';
import {
  assetPrefix,
  type ObjectStorage,
  parseUploadSourceKey,
  UPLOADS_PREFIX,
} from '@udemy/storage';

/**
 * MediaCleanupJob steps A-D (design §5, schema doc §8.2) as plain functions over three ports, so
 * the decision logic is unit-testable: the operational SQL (`@udemy/db`), the object storage
 * (`@udemy/storage`), and a runner that opens a transaction holding the cleanup advisory lock.
 *
 * Rules every step follows:
 * - DB work runs in short transactions that first take the advisory lock; when another replica
 *   holds it, the step reports `locked` and the run stops.
 * - S3 is only called with no transaction open (after COMMIT).
 * - An S3 failure is logged and counted, and the row is NOT marked done: the next run retries it
 *   (A: step B aborts the leftover multipart; C: C2 retries the deletion; D: the row is found
 *   again). A step stops looping on S3 failures instead of re-reading the same rows.
 */

/** Step B only aborts multipart uploads initiated longer ago than this (design §5 B). */
export const ORPHAN_MULTIPART_MIN_AGE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** The `@udemy/db` cleanup functions (+ the MediaPurged outbox insert) the steps use. */
export interface MediaCleanupSql {
  abortStaleUploads(
    trx: Transaction<DB>,
    options: { ttlHours: number; batchSize: number },
  ): Promise<AbortedUpload[]>;
  findLiveUploadIds(trx: Transaction<DB>, uploadIds: readonly string[]): Promise<Set<string>>;
  purgeUnusedAssets(trx: Transaction<DB>, options: PurgeOptions): Promise<PurgedAsset[]>;
  /** Outbox `MediaPurged` for one purged asset, in the purge transaction. */
  insertMediaPurged(trx: Transaction<DB>, asset: PurgedAsset): Promise<void>;
  markAssetObjectsDeleted(trx: Transaction<DB>, assetId: string): Promise<boolean>;
  findAssetsPendingObjectDeletion(
    trx: Transaction<DB>,
    options: { batchSize: number },
  ): Promise<AssetObjectsToDelete[]>;
  findExpiredReadySources(
    trx: Transaction<DB>,
    options: { retentionDays: number; batchSize: number },
  ): Promise<SourceToDelete[]>;
  findStaleFailedSources(
    trx: Transaction<DB>,
    options: { batchSize: number },
  ): Promise<SourceToDelete[]>;
  markSourcesDeleted(trx: Transaction<DB>, assetIds: readonly string[]): Promise<number>;
}

/** Production binding of `MediaCleanupSql` to `@udemy/db`. */
export const dbMediaCleanupSql: MediaCleanupSql = {
  abortStaleUploads,
  findLiveUploadIds,
  purgeUnusedAssets,
  async insertMediaPurged(trx, asset) {
    // purged_at was set with now() in this transaction, and now() is constant per transaction.
    const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    const purgedAt = rows[0]?.now ?? new Date();
    const payload = MediaPurged.parsePayload({
      assetId: asset.id,
      ownerId: asset.ownerId,
      purgedAt: purgedAt.toISOString(),
    });
    await insertOutboxEvent(trx, {
      aggregateType: MediaPurged.aggregateType,
      aggregateId: asset.id,
      type: MediaPurged.qualifiedType,
      payload,
    });
  },
  markAssetObjectsDeleted,
  findAssetsPendingObjectDeletion,
  findExpiredReadySources,
  findStaleFailedSources,
  markSourcesDeleted,
};

/** The storage calls the steps make. */
export type CleanupStorage = Pick<
  ObjectStorage,
  'abortMultipartUpload' | 'listMultipartUploads' | 'deletePrefix' | 'deleteObject'
>;

export type LockedResult<T> =
  { readonly acquired: true; readonly value: T } | { readonly acquired: false };

export interface CleanupLog {
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface MediaCleanupContext {
  readonly sql: MediaCleanupSql;
  readonly storage: CleanupStorage;
  /** Runs `fn` in a transaction holding the cleanup advisory lock (try-lock; no wait). */
  runLocked<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<LockedResult<T>>;
  /** Upper bound of batches per step and run. */
  readonly maxBatches: number;
  /** True once shutdown started: finish the current batch, then stop. */
  shouldStop(): boolean;
  readonly log: CleanupLog;
  now(): Date;
}

export interface StepResult {
  readonly status: 'completed' | 'locked';
  /** Rows / objects handled, by counter name. */
  readonly counts: Readonly<Record<string, number>>;
  /** S3 calls that failed (logged; retried on a later run). */
  readonly s3Failures: number;
}

export interface MediaCleanupStep {
  readonly name: string;
  run(ctx: MediaCleanupContext): Promise<StepResult>;
}

export interface MediaCleanupOptions {
  readonly batchSize: number;
  /** A: MEDIA_UPLOAD_TTL_HOURS. */
  readonly uploadTtlHours: number;
  /** C: MEDIA_UNATTACHED_GRACE_HOURS. */
  readonly neverUsedGraceHours: number;
  /** C: MEDIA_UNUSED_GRACE_DAYS. */
  readonly releasedGraceDays: number;
  /** D: MEDIA_SOURCE_RETENTION_DAYS. */
  readonly sourceRetentionDays: number;
  /** B: minimum age of an orphan multipart upload. Default ORPHAN_MULTIPART_MIN_AGE_HOURS. */
  readonly orphanMultipartMinAgeHours?: number;
  /**
   * B: key prefix listed in the uploads bucket. Default `uploads/`. Integration tests narrow it
   * to `uploads/{their owner id}/` so they never touch other uploads in a shared MinIO.
   */
  readonly uploadsPrefix?: string;
}

/** Mutable tally of one step. */
class Tally {
  readonly counts: Record<string, number> = {};
  s3Failures = 0;

  constructor(names: readonly string[]) {
    for (const name of names) this.counts[name] = 0;
  }

  add(name: string, n = 1): void {
    this.counts[name] = (this.counts[name] ?? 0) + n;
  }

  result(status: StepResult['status']): StepResult {
    return { status, counts: { ...this.counts }, s3Failures: this.s3Failures };
  }
}

function errorInfo(error: unknown): { err: string } {
  return { err: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}

/** `uploads/{owner}/{asset}/` of a purged asset, only if `sourceKey` has exactly that layout. */
export function uploadsPrefixOf(asset: {
  id: string;
  ownerId: string;
  sourceKey: string;
}): string | null {
  const parsed = parseUploadSourceKey(asset.sourceKey);
  if (parsed === null || parsed.assetId !== asset.id || parsed.ownerId !== asset.ownerId) {
    return null;
  }
  return `${UPLOADS_PREFIX}${parsed.ownerId}/${parsed.assetId}/`;
}

/**
 * Deletes every object of a purged asset: `uploads/{owner}/{asset}/` (quarantine) and
 * `assets/{asset}/` (all output versions, which covers `output_prefix` and any partial output
 * of failed attempts). True only when both prefixes are confirmed empty.
 */
async function deleteAssetObjects(
  ctx: MediaCleanupContext,
  asset: { id: string; ownerId: string; sourceKey: string },
): Promise<boolean> {
  const uploads = uploadsPrefixOf(asset);
  if (uploads === null) {
    ctx.log.error(
      { assetId: asset.id, sourceKey: asset.sourceKey },
      'Media cleanup: unexpected source key layout; objects NOT deleted',
    );
    return false;
  }
  try {
    await ctx.storage.deletePrefix({ bucket: 'uploads', prefix: uploads });
    await ctx.storage.deletePrefix({ bucket: 'media', prefix: assetPrefix(asset.id) });
    return true;
  } catch (error) {
    ctx.log.warn(
      { assetId: asset.id, ...errorInfo(error) },
      'Media cleanup: deleting asset objects failed; retried on a later run',
    );
    return false;
  }
}

/** Marks purged assets whose objects are gone (own locked transaction, after the S3 calls). */
async function markObjectsDeleted(
  ctx: MediaCleanupContext,
  assetIds: readonly string[],
): Promise<LockedResult<number>> {
  if (assetIds.length === 0) return { acquired: true, value: 0 };
  return ctx.runLocked(async (trx) => {
    let marked = 0;
    for (const id of assetIds) {
      if (await ctx.sql.markAssetObjectsDeleted(trx, id)) marked += 1;
    }
    return marked;
  });
}

// ------------------------------------------------------------------------------------------ A

/** A. UPLOADING older than the TTL -> ABORTED (DB), then abort the multipart upload in S3. */
export function staleUploadsStep(options: MediaCleanupOptions): MediaCleanupStep {
  return {
    name: 'stale_uploads',
    async run(ctx) {
      const tally = new Tally(['assets_aborted', 'multiparts_aborted']);
      for (let batch = 0; batch < ctx.maxBatches && !ctx.shouldStop(); batch += 1) {
        const locked = await ctx.runLocked((trx) =>
          ctx.sql.abortStaleUploads(trx, {
            ttlHours: options.uploadTtlHours,
            batchSize: options.batchSize,
          }),
        );
        if (!locked.acquired) return tally.result('locked');
        const rows = locked.value;
        tally.add('assets_aborted', rows.length);
        for (const row of rows) {
          try {
            await ctx.storage.abortMultipartUpload({
              bucket: 'uploads',
              key: row.sourceKey,
              uploadId: row.s3UploadId,
            });
            tally.add('multiparts_aborted');
          } catch (error) {
            // The DB row is ABORTED already; step B finds the multipart (no live row) and retries.
            tally.s3Failures += 1;
            ctx.log.warn(
              { assetId: row.id, ...errorInfo(error) },
              'Media cleanup: S3 abort of a stale upload failed; step B retries it',
            );
          }
        }
        if (rows.length < options.batchSize) break;
      }
      return tally.result('completed');
    },
  };
}

// ------------------------------------------------------------------------------------------ B

/**
 * B. Multipart uploads under `uploads/` initiated more than 24 h ago whose UploadId belongs to
 * no UPLOADING asset -> abort. MinIO ignores the Prefix filter, so `listMultipartUploads`
 * filters client-side (design §14). Uploads without an `initiated` date are left alone.
 */
export function orphanMultipartsStep(options: MediaCleanupOptions): MediaCleanupStep {
  const prefix = options.uploadsPrefix ?? UPLOADS_PREFIX;
  const minAgeHours = options.orphanMultipartMinAgeHours ?? ORPHAN_MULTIPART_MIN_AGE_HOURS;
  return {
    name: 'orphan_multiparts',
    async run(ctx) {
      const tally = new Tally(['multiparts_checked', 'multiparts_aborted']);
      const cutoff = ctx.now().getTime() - minAgeHours * HOUR_MS;
      let batches = 0;

      /** Checks one chunk against the DB, then aborts the orphans. False when locked out. */
      const processChunk = async (
        chunk: readonly { key: string; uploadId: string }[],
      ): Promise<boolean> => {
        batches += 1;
        const locked = await ctx.runLocked((trx) =>
          ctx.sql.findLiveUploadIds(
            trx,
            chunk.map((u) => u.uploadId),
          ),
        );
        if (!locked.acquired) return false;
        tally.add('multiparts_checked', chunk.length);
        for (const upload of chunk) {
          if (locked.value.has(upload.uploadId)) continue;
          try {
            await ctx.storage.abortMultipartUpload({
              bucket: 'uploads',
              key: upload.key,
              uploadId: upload.uploadId,
            });
            tally.add('multiparts_aborted');
          } catch (error) {
            tally.s3Failures += 1;
            ctx.log.warn(
              { key: upload.key, ...errorInfo(error) },
              'Media cleanup: S3 abort of an orphan multipart upload failed; retried on a later run',
            );
          }
        }
        return true;
      };

      let chunk: { key: string; uploadId: string }[] = [];
      try {
        for await (const upload of ctx.storage.listMultipartUploads({
          bucket: 'uploads',
          prefix,
        })) {
          if (upload.initiated === undefined || upload.initiated.getTime() >= cutoff) continue;
          chunk.push({ key: upload.key, uploadId: upload.uploadId });
          if (chunk.length < options.batchSize) continue;
          if (!(await processChunk(chunk))) return tally.result('locked');
          chunk = [];
          if (batches >= ctx.maxBatches || ctx.shouldStop()) {
            return tally.result('completed');
          }
        }
      } catch (error) {
        tally.s3Failures += 1;
        ctx.log.warn(
          errorInfo(error),
          'Media cleanup: listing multipart uploads failed; retried on a later run',
        );
        return tally.result('completed');
      }
      if (chunk.length > 0 && !(await processChunk(chunk))) return tally.result('locked');
      return tally.result('completed');
    },
  };
}

// ----------------------------------------------------------------------------------------- C2

/** C2. Purged assets whose object deletion has not been confirmed yet (retry). */
export function pendingObjectDeletionsStep(options: MediaCleanupOptions): MediaCleanupStep {
  return {
    name: 'pending_object_deletions',
    async run(ctx) {
      const tally = new Tally(['assets_objects_deleted']);
      for (let batch = 0; batch < ctx.maxBatches && !ctx.shouldStop(); batch += 1) {
        const locked = await ctx.runLocked((trx) =>
          ctx.sql.findAssetsPendingObjectDeletion(trx, { batchSize: options.batchSize }),
        );
        if (!locked.acquired) return tally.result('locked');
        const rows = locked.value;
        const done: string[] = [];
        for (const asset of rows) {
          if (await deleteAssetObjects(ctx, asset)) done.push(asset.id);
          else tally.s3Failures += 1;
        }
        const marked = await markObjectsDeleted(ctx, done);
        if (!marked.acquired) return tally.result('locked');
        tally.add('assets_objects_deleted', marked.value);
        // Failed rows would be read again at once: leave them for the next run.
        if (done.length < rows.length || rows.length < options.batchSize) break;
      }
      return tally.result('completed');
    },
  };
}

// ------------------------------------------------------------------------------------------ C

/**
 * C. Purge unused assets past their grace period (DB, with `MediaPurged` in the same
 * transaction), then delete their objects, then `markAssetObjectsDeleted`. Assets whose deletion
 * failed stay purged with `objects_deleted_at` NULL and are retried by C2.
 */
export function purgeStep(options: MediaCleanupOptions): MediaCleanupStep {
  return {
    name: 'purge',
    async run(ctx) {
      const tally = new Tally(['assets_purged', 'assets_objects_deleted']);
      for (let batch = 0; batch < ctx.maxBatches && !ctx.shouldStop(); batch += 1) {
        const locked = await ctx.runLocked(async (trx) => {
          const rows = await ctx.sql.purgeUnusedAssets(trx, {
            neverUsedGraceHours: options.neverUsedGraceHours,
            releasedGraceDays: options.releasedGraceDays,
            batchSize: options.batchSize,
          });
          for (const row of rows) await ctx.sql.insertMediaPurged(trx, row);
          return rows;
        });
        if (!locked.acquired) return tally.result('locked');
        const rows = locked.value;
        tally.add('assets_purged', rows.length);
        const done: string[] = [];
        for (const asset of rows) {
          if (await deleteAssetObjects(ctx, asset)) done.push(asset.id);
          else tally.s3Failures += 1;
        }
        const marked = await markObjectsDeleted(ctx, done);
        if (!marked.acquired) return tally.result('locked');
        tally.add('assets_objects_deleted', marked.value);
        // Purged rows never come back from purgeUnusedAssets, so failures cannot loop here.
        if (rows.length < options.batchSize) break;
      }
      return tally.result('completed');
    },
  };
}

// ------------------------------------------------------------------------------------------ D

function sourceDeletionStep(
  name: string,
  options: MediaCleanupOptions,
  find: (ctx: MediaCleanupContext, trx: Transaction<DB>) => Promise<SourceToDelete[]>,
): MediaCleanupStep {
  return {
    name,
    async run(ctx) {
      const tally = new Tally(['sources_deleted']);
      for (let batch = 0; batch < ctx.maxBatches && !ctx.shouldStop(); batch += 1) {
        const locked = await ctx.runLocked((trx) => find(ctx, trx));
        if (!locked.acquired) return tally.result('locked');
        const rows = locked.value;
        const done: string[] = [];
        for (const row of rows) {
          const parsed = parseUploadSourceKey(row.sourceKey);
          if (parsed === null || parsed.assetId !== row.id) {
            tally.s3Failures += 1;
            ctx.log.error(
              { assetId: row.id, sourceKey: row.sourceKey },
              'Media cleanup: unexpected source key layout; source NOT deleted',
            );
            continue;
          }
          try {
            await ctx.storage.deleteObject({ bucket: 'uploads', key: row.sourceKey });
            done.push(row.id);
          } catch (error) {
            tally.s3Failures += 1;
            ctx.log.warn(
              { assetId: row.id, ...errorInfo(error) },
              'Media cleanup: deleting a source failed; retried on a later run',
            );
          }
        }
        if (done.length > 0) {
          const marked = await ctx.runLocked((trx) => ctx.sql.markSourcesDeleted(trx, done));
          if (!marked.acquired) return tally.result('locked');
          tally.add('sources_deleted', marked.value);
        }
        if (done.length < rows.length || rows.length < options.batchSize) break;
      }
      return tally.result('completed');
    },
  };
}

/** D. READY sources older than MEDIA_SOURCE_RETENTION_DAYS (decision Q5). */
export function expiredSourcesStep(options: MediaCleanupOptions): MediaCleanupStep {
  return sourceDeletionStep('expired_sources', options, (ctx, trx) =>
    ctx.sql.findExpiredReadySources(trx, {
      retentionDays: options.sourceRetentionDays,
      batchSize: options.batchSize,
    }),
  );
}

/** D'. FAILED sources older than 1 h (backstop: the transcoder normally deletes them at once). */
export function failedSourcesStep(options: MediaCleanupOptions): MediaCleanupStep {
  return sourceDeletionStep('failed_sources', options, (ctx, trx) =>
    ctx.sql.findStaleFailedSources(trx, { batchSize: options.batchSize }),
  );
}

/** Every step in run order: A, B, C2 (retries first), C, D, D'. */
export function mediaCleanupSteps(options: MediaCleanupOptions): MediaCleanupStep[] {
  return [
    staleUploadsStep(options),
    orphanMultipartsStep(options),
    pendingObjectDeletionsStep(options),
    purgeStep(options),
    expiredSourcesStep(options),
    failedSourcesStep(options),
  ];
}
