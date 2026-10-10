/**
 * Transcoder job lifecycle SQL (docs/phase-2-schema-design.md §8.1), for apps/transcoder (T12)
 * and the worker's enqueuer (T13).
 *
 * Fencing: every write after the lease is conditioned on
 * `status = 'RUNNING' AND lease_owner = $worker AND lease_count = $leaseNo`. `leaseNo`
 * (= transcode_jobs.lease_count = transcode_attempts.attempt_no = the `a{n}` output prefix) is
 * monotonic, so a worker whose lease expired and was re-leased can never write again.
 *
 * Lock order: job row, then asset row (never the reverse). Must run at READ COMMITTED.
 * `LISTEN media_transcode` is the caller's job, on a dedicated non-pooled `pg.Client`; polling
 * `leaseTranscodeJob` is the correctness path.
 */
import { sql, type Transaction } from 'kysely';
import type { DB } from '../generated/db';
import { assertBatchSize, assertIntInRange, assertNonEmptyText } from '../internal/assert';
import { type Executor, inTransaction } from '../transaction';

/** `transcode_jobs.last_error_code` / `transcode_attempts.error_code` values. */
export const TRANSCODE_ERROR_CODES = [
  'INVALID_MEDIA',
  'UNSUPPORTED_MEDIA',
  'TOO_LONG',
  'TOO_LARGE_DIMENSIONS',
  'TRANSCODE_ERROR',
  'TIMEOUT',
  'INTERNAL',
  'CRASHED',
] as const;
export type TranscodeErrorCode = (typeof TRANSCODE_ERROR_CODES)[number];

/**
 * Thrown inside a multi-statement step when a fenced UPDATE matched 0 rows: the lease was lost
 * (expired and reaped / re-leased). The surrounding transaction must roll back; the worker must
 * stop ffmpeg and discard its outputs. Not an error to report, just "lease lost" (§9).
 */
export class TranscodeLeaseLostError extends Error {
  constructor(
    readonly assetId: string,
    readonly leaseNo: number,
    readonly step: string,
  ) {
    super(`transcode lease ${assetId}/a${leaseNo} lost at ${step}`);
    this.name = 'TranscodeLeaseLostError';
  }
}

export interface LeaseFence {
  assetId: string;
  workerId: string;
  /** `lease_count` returned by the lease (the fencing token). */
  leaseNo: number;
}

const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

function assertFence(fence: LeaseFence): void {
  assertNonEmptyText('workerId', fence.workerId, 128);
  assertIntInRange('leaseNo', fence.leaseNo, 1, 2_147_483_647);
}

/** `assets/{assetId}/a{leaseNo}/`: the only output prefix `assets_output_prefix_ck` accepts. */
export function transcodeOutputPrefix(assetId: string, leaseNo: number): string {
  return `assets/${assetId}/a${leaseNo}/`;
}

// ---------------------------------------------------------------------------------- enqueue

/** `transcode_jobs_max_attempts_ck`: `max_attempts BETWEEN 1 AND 10`. */
export const MAX_TRANSCODE_ATTEMPTS_LIMIT = 10;

export interface EnqueueTranscodeJobInput {
  assetId: string;
  /**
   * Penalised attempts before the job FAILs terminally (e.g. the worker's
   * `TRANSCODER_MAX_ATTEMPTS`), 1..10. Omitted: the column default (3). Only applies when this
   * call creates the job; an existing job keeps its value.
   */
  maxAttempts?: number;
}

/**
 * Idempotent enqueue (worker, inside its MediaUploaded claim transaction). Inserts nothing if
 * the job exists or the asset is not UPLOADED / is purged. Returns true when a job was created.
 *
 * Accepts the asset id alone (original signature) or `{ assetId, maxAttempts? }`.
 */
export async function enqueueTranscodeJob(
  executor: Executor,
  input: string | EnqueueTranscodeJobInput,
): Promise<boolean> {
  const { assetId, maxAttempts } = typeof input === 'string' ? { assetId: input } : input;
  if (maxAttempts !== undefined) {
    assertIntInRange('maxAttempts', maxAttempts, 1, MAX_TRANSCODE_ATTEMPTS_LIMIT);
  }
  const result =
    maxAttempts === undefined
      ? await sql`
    INSERT INTO media.transcode_jobs (asset_id)
    SELECT id FROM media.assets WHERE id = ${assetId} AND status = 'UPLOADED' AND purged_at IS NULL
    ON CONFLICT (asset_id) DO NOTHING
  `.execute(executor)
      : await sql`
    INSERT INTO media.transcode_jobs (asset_id, max_attempts)
    SELECT id, ${maxAttempts}::integer FROM media.assets
    WHERE id = ${assetId} AND status = 'UPLOADED' AND purged_at IS NULL
    ON CONFLICT (asset_id) DO NOTHING
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

// ------------------------------------------------------------------------------------ lease

export interface LeaseOptions {
  workerId: string;
  /** Lease length; renewed by heartbeats (suggested: 3x the heartbeat interval). */
  leaseMs: number;
}

export interface LeasedAssetInfo {
  ownerId: string;
  purpose: string;
  sourceKey: string;
  /** int8 -> string. */
  declaredSizeBytes: string;
  declaredContentType: string;
}

export type LeaseResult =
  | {
      kind: 'leased';
      assetId: string;
      leaseNo: number;
      /** Penalised attempts including this one. */
      attempts: number;
      maxAttempts: number;
      asset: LeasedAssetInfo;
    }
  /** The asset was purged or is no longer processable: the job is now CANCELLED. Poll again. */
  | { kind: 'cancelled'; assetId: string; leaseNo: number };

/**
 * L1-L3 in ONE transaction: lease the oldest due QUEUED job (`FOR UPDATE SKIP LOCKED`), move the
 * asset to PROCESSING and open the attempt row. Returns null when nothing is due.
 */
export async function leaseTranscodeJob(
  executor: Executor,
  options: LeaseOptions,
): Promise<LeaseResult | null> {
  assertNonEmptyText('workerId', options.workerId, 128);
  assertIntInRange('leaseMs', options.leaseMs, 1_000, MAX_LEASE_MS);

  return inTransaction(executor, async (trx) => {
    const { rows: jobs } = await sql<{
      assetId: string;
      attempts: number;
      maxAttempts: number;
      leaseCount: number;
    }>`
      WITH next AS (
        SELECT asset_id FROM media.transcode_jobs
         WHERE status = 'QUEUED' AND run_after <= now()
         ORDER BY run_after, asset_id
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      UPDATE media.transcode_jobs j
         SET status = 'RUNNING', attempts = j.attempts + 1, lease_count = j.lease_count + 1,
             lease_owner = ${options.workerId},
             lease_expires_at = now() + ${options.leaseMs}::int * interval '1 millisecond',
             heartbeat_at = now(), progress_pct = 0
        FROM next WHERE j.asset_id = next.asset_id
      RETURNING j.asset_id, j.attempts, j.max_attempts, j.lease_count
    `.execute(trx);
    const job = jobs[0];
    if (job === undefined) return null;
    const leaseNo = job.leaseCount;

    const { rows: assets } = await sql<LeasedAssetInfo>`
      UPDATE media.assets SET status = 'PROCESSING'
       WHERE id = ${job.assetId} AND status IN ('UPLOADED','PROCESSING') AND purged_at IS NULL
      RETURNING owner_id, purpose, source_key, declared_size_bytes, declared_content_type
    `.execute(trx);
    const asset = assets[0];

    if (asset === undefined) {
      await sql`
        UPDATE media.transcode_jobs
           SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
         WHERE asset_id = ${job.assetId} AND lease_count = ${leaseNo}
      `.execute(trx);
      return { kind: 'cancelled', assetId: job.assetId, leaseNo };
    }

    await sql`
      INSERT INTO media.transcode_attempts (asset_id, attempt_no, worker_id)
      VALUES (${job.assetId}, ${leaseNo}, ${options.workerId})
    `.execute(trx);

    return {
      kind: 'leased',
      assetId: job.assetId,
      leaseNo,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      asset,
    };
  });
}

// -------------------------------------------------------------------------------- heartbeat

/**
 * Extends the lease. Returns the new expiry, or null when the lease is lost (0 rows): the caller
 * must SIGKILL ffmpeg and discard its outputs. `progressPct` never moves backwards.
 */
export async function heartbeatTranscodeJob(
  executor: Executor,
  fence: LeaseFence & { leaseMs: number; progressPct?: number },
): Promise<Date | null> {
  assertFence(fence);
  assertIntInRange('leaseMs', fence.leaseMs, 1_000, MAX_LEASE_MS);
  const pct = fence.progressPct ?? 0;
  assertIntInRange('progressPct', pct, 0, 100);
  const { rows } = await sql<{ leaseExpiresAt: Date }>`
    UPDATE media.transcode_jobs
       SET lease_expires_at = now() + ${fence.leaseMs}::int * interval '1 millisecond',
           heartbeat_at = now(),
           progress_pct = GREATEST(coalesce(progress_pct, 0), ${pct}::smallint)
     WHERE asset_id = ${fence.assetId} AND status = 'RUNNING'
       AND lease_owner = ${fence.workerId} AND lease_count = ${fence.leaseNo}
    RETURNING lease_expires_at
  `.execute(executor);
  return rows[0]?.leaseExpiresAt ?? null;
}

// --------------------------------------------------------------------------------- complete

export interface RenditionInput {
  /** 360p|480p|720p|1080p|src{h}p|w750|w480|poster|sprite (asset_renditions_name_ck). */
  name: string;
  kind: 'HLS_VARIANT' | 'IMAGE' | 'SPRITE';
  width: number;
  height: number;
  /** Required for HLS_VARIANT, null otherwise. */
  bandwidthBps: number | null;
  /** Required for HLS_VARIANT, null otherwise. */
  codecs: string | null;
  /** Must start with the output prefix (`assets/{id}/a{leaseNo}/`). */
  objectKey: string;
}

export interface CompleteInput extends LeaseFence {
  /** Required for LECTURE_VIDEO; null otherwise. */
  durationMs: number | null;
  /** Required unless LECTURE_RESOURCE (then null). */
  width: number | null;
  height: number | null;
  detectedFormat: string | null;
  renditions: readonly RenditionInput[];
}

export interface CompletedAsset {
  id: string;
  ownerId: string;
  purpose: string;
  outputPrefix: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  readyAt: Date;
}

/**
 * COMPLETE: job SUCCEEDED, asset READY (output prefix `a{leaseNo}`), renditions, attempt
 * SUCCEEDED. Throws TranscodeLeaseLostError on any 0-row step, so the transaction rolls back.
 * Pass the transaction in which you also insert the MediaReady outbox event.
 */
export async function completeTranscodeJob(
  executor: Executor,
  input: CompleteInput,
): Promise<CompletedAsset> {
  assertFence(input);
  return inTransaction(executor, (trx) => completeInTransaction(trx, input));
}

async function completeInTransaction(
  trx: Transaction<DB>,
  input: CompleteInput,
): Promise<CompletedAsset> {
  const { assetId, workerId, leaseNo } = input;

  const job = await sql`
    UPDATE media.transcode_jobs
       SET status = 'SUCCEEDED', progress_pct = 100, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = NULL, finished_at = now()
     WHERE asset_id = ${assetId} AND status = 'RUNNING'
       AND lease_owner = ${workerId} AND lease_count = ${leaseNo}
  `.execute(trx);
  if (Number(job.numAffectedRows ?? 0n) !== 1) {
    throw new TranscodeLeaseLostError(assetId, leaseNo, 'complete:job');
  }

  const { rows } = await sql<CompletedAsset>`
    UPDATE media.assets
       SET status = 'READY', output_prefix = ${transcodeOutputPrefix(assetId, leaseNo)},
           duration_ms = ${input.durationMs}, width = ${input.width}, height = ${input.height},
           detected_format = ${input.detectedFormat}, ready_at = now()
     WHERE id = ${assetId} AND status = 'PROCESSING'
    RETURNING id, owner_id, purpose, output_prefix, duration_ms, width, height, ready_at
  `.execute(trx);
  const asset = rows[0];
  if (asset === undefined) throw new TranscodeLeaseLostError(assetId, leaseNo, 'complete:asset');

  if (input.renditions.length > 0) {
    await trx
      .insertInto('media.assetRenditions')
      .values(input.renditions.map((r) => ({ ...r, assetId })))
      .execute();
  }

  await finishAttempt(trx, input, { outcome: 'SUCCEEDED' }, 'complete:attempt');
  return asset;
}

async function finishAttempt(
  executor: Executor,
  fence: LeaseFence,
  result: {
    outcome: 'SUCCEEDED' | 'RETRY' | 'FAILED' | 'RELEASED';
    errorCode?: TranscodeErrorCode;
    errorDetail?: string | null;
  },
  step: string,
): Promise<void> {
  const updated = await sql`
    UPDATE media.transcode_attempts
       SET finished_at = now(), outcome = ${result.outcome},
           error_code = ${result.errorCode ?? null}, error_detail = ${result.errorDetail ?? null}
     WHERE asset_id = ${fence.assetId} AND attempt_no = ${fence.leaseNo} AND finished_at IS NULL
  `.execute(executor);
  if (Number(updated.numAffectedRows ?? 0n) !== 1) {
    throw new TranscodeLeaseLostError(fence.assetId, fence.leaseNo, step);
  }
}

// ------------------------------------------------------------------------------------- fail

export interface FailInput extends LeaseFence {
  code: TranscodeErrorCode;
  /** Internal only (<= 2000 chars, truncated). Never user-visible. */
  detail?: string | null;
  /** Retryable errors requeue with backoff while attempts remain; otherwise terminal. */
  retryable: boolean;
}

export interface FailedAssetInfo {
  ownerId: string;
  purpose: string;
  sourceKey: string;
}

export type FailResult =
  /** Requeued with exponential backoff (`now() + 2^attempts minutes`). */
  | { outcome: 'RETRY'; runAfter: Date }
  /**
   * Terminal: job FAILED, asset FAILED (asset is null if it was no longer PROCESSING). Emit
   * MediaFailed{attempts} in the same transaction; delete the source after COMMIT, then call
   * markSourcesDeleted().
   */
  | { outcome: 'FAILED'; attempts: number; asset: FailedAssetInfo | null };

function truncateDetail(detail: string | null | undefined): string | null {
  if (detail === undefined || detail === null || detail === '') return null;
  return detail.length > 2000 ? detail.slice(0, 2000) : detail;
}

/**
 * FAIL (retryable or terminal). A retryable failure with no attempts left takes the terminal
 * path. Throws TranscodeLeaseLostError if the lease is gone. Pass your transaction when you
 * insert MediaFailed.
 */
export async function failTranscodeJob(executor: Executor, input: FailInput): Promise<FailResult> {
  assertFence(input);
  if (!TRANSCODE_ERROR_CODES.includes(input.code)) {
    throw new RangeError(`unknown transcode error code ${String(input.code)}`);
  }
  const detail = truncateDetail(input.detail);
  const { assetId, workerId, leaseNo, code } = input;

  return inTransaction(executor, async (trx) => {
    if (input.retryable) {
      const { rows } = await sql<{ runAfter: Date }>`
        UPDATE media.transcode_jobs
           SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL, progress_pct = NULL,
               last_error_code = ${code}, run_after = now() + make_interval(mins => power(2, attempts)::int)
         WHERE asset_id = ${assetId} AND status = 'RUNNING'
           AND lease_owner = ${workerId} AND lease_count = ${leaseNo}
           AND attempts < max_attempts
        RETURNING run_after
      `.execute(trx);
      const requeued = rows[0];
      if (requeued !== undefined) {
        await finishAttempt(
          trx,
          input,
          { outcome: 'RETRY', errorCode: code, errorDetail: detail },
          'fail:attempt',
        );
        return { outcome: 'RETRY', runAfter: requeued.runAfter };
      }
    }

    const { rows: jobs } = await sql<{ attempts: number }>`
      UPDATE media.transcode_jobs
         SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = ${code}, finished_at = now()
       WHERE asset_id = ${assetId} AND status = 'RUNNING'
         AND lease_owner = ${workerId} AND lease_count = ${leaseNo}
      RETURNING attempts
    `.execute(trx);
    const job = jobs[0];
    if (job === undefined) throw new TranscodeLeaseLostError(assetId, leaseNo, 'fail:job');

    const { rows: assets } = await sql<FailedAssetInfo>`
      UPDATE media.assets SET status = 'FAILED', failure_code = ${code}, failed_at = now()
       WHERE id = ${assetId} AND status = 'PROCESSING'
      RETURNING owner_id, purpose, source_key
    `.execute(trx);

    await finishAttempt(
      trx,
      input,
      { outcome: 'FAILED', errorCode: code, errorDetail: detail },
      'fail:attempt',
    );
    return { outcome: 'FAILED', attempts: job.attempts, asset: assets[0] ?? null };
  });
}

// ---------------------------------------------------------------------------------- release

/**
 * GRACEFUL RELEASE (SIGTERM): requeue at once without penalty (`attempts - 1`). The lease number
 * is not reused (lease_count stays). Returns false when the lease was already lost.
 */
export async function releaseTranscodeJob(executor: Executor, fence: LeaseFence): Promise<boolean> {
  assertFence(fence);
  return inTransaction(executor, async (trx) => {
    const job = await sql`
      UPDATE media.transcode_jobs
         SET status = 'QUEUED', attempts = attempts - 1, lease_owner = NULL, lease_expires_at = NULL,
             progress_pct = NULL, run_after = now()
       WHERE asset_id = ${fence.assetId} AND status = 'RUNNING'
         AND lease_owner = ${fence.workerId} AND lease_count = ${fence.leaseNo}
    `.execute(trx);
    if (Number(job.numAffectedRows ?? 0n) !== 1) return false;
    await finishAttempt(trx, fence, { outcome: 'RELEASED' }, 'release:attempt');
    return true;
  });
}

// ----------------------------------------------------------------------------------- reaper

export type ReapedLease =
  | { assetId: string; leaseNo: number; outcome: 'REQUEUED' }
  /** Attempts exhausted: emit MediaFailed (code CRASHED) in the same transaction if `asset` is set. */
  | {
      assetId: string;
      leaseNo: number;
      outcome: 'FAILED';
      attempts: number;
      asset: FailedAssetInfo | null;
    };

/**
 * REAPER (before each poll; one transaction per batch): closes attempts of expired leases as
 * LEASE_LOST/CRASHED, then requeues the job or fails it terminally (job + asset FAILED 'CRASHED').
 * Pass your transaction when you insert MediaFailed for the terminal rows.
 */
export async function reapExpiredTranscodeLeases(
  executor: Executor,
  options: { batchSize: number },
): Promise<ReapedLease[]> {
  assertBatchSize(options.batchSize);
  return inTransaction(executor, async (trx) => {
    const { rows: expired } = await sql<{
      assetId: string;
      attempts: number;
      maxAttempts: number;
      leaseCount: number;
    }>`
      SELECT asset_id, attempts, max_attempts, lease_count FROM media.transcode_jobs
       WHERE status = 'RUNNING' AND lease_expires_at < now()
       ORDER BY lease_expires_at LIMIT ${options.batchSize}
       FOR UPDATE SKIP LOCKED
    `.execute(trx);

    const reaped: ReapedLease[] = [];
    for (const job of expired) {
      const { assetId, leaseCount: leaseNo } = job;
      await sql`
        UPDATE media.transcode_attempts SET finished_at = now(), outcome = 'LEASE_LOST', error_code = 'CRASHED'
         WHERE asset_id = ${assetId} AND attempt_no = ${leaseNo} AND finished_at IS NULL
      `.execute(trx);

      if (job.attempts < job.maxAttempts) {
        await sql`
          UPDATE media.transcode_jobs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL,
                 progress_pct = NULL, last_error_code = 'CRASHED', run_after = now()
           WHERE asset_id = ${assetId} AND status = 'RUNNING' AND lease_count = ${leaseNo}
        `.execute(trx);
        reaped.push({ assetId, leaseNo, outcome: 'REQUEUED' });
        continue;
      }

      await sql`
        UPDATE media.transcode_jobs SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = 'CRASHED', finished_at = now()
         WHERE asset_id = ${assetId} AND status = 'RUNNING' AND lease_count = ${leaseNo}
      `.execute(trx);
      const { rows: assets } = await sql<FailedAssetInfo>`
        UPDATE media.assets SET status = 'FAILED', failure_code = 'CRASHED', failed_at = now()
         WHERE id = ${assetId} AND status = 'PROCESSING'
        RETURNING owner_id, purpose, source_key
      `.execute(trx);
      reaped.push({
        assetId,
        leaseNo,
        outcome: 'FAILED',
        attempts: job.attempts,
        asset: assets[0] ?? null,
      });
    }
    return reaped;
  });
}
