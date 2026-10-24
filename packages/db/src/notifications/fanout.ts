/**
 * Leased announcement fan-out (docs/phase-5-schema-design.md §8.6, P5-D11, race R10), the P2
 * transcode-job pattern.
 *
 * Fencing: every batch starts with `lockFanoutBatch`, a `SELECT ... FOR UPDATE` conditioned on
 * `status = 'RUNNING' AND lease_owner = $worker AND attempts = $attempt`. `attempts` grows with
 * every lease, so a worker whose lease expired and was re-leased can never write again: 0 rows =
 * lease lost, stop without inserting. One batch = one transaction: fence + <= 1000 notification
 * inserts + cursor advance. A reaper that requeues while a batch runs waits on the job row lock;
 * the batch extends the lease, so the reaper then skips the job. Duplicates are impossible anyway
 * (`notifications_user_id_kind_source_event_id_uq`); push/e-mail only the rows `RETURNING` gave
 * back, after COMMIT.
 */
import { sql } from 'kysely';
import type { Json } from '../generated/db';
import { assertBatchSize, assertIntInRange, assertNonEmptyText } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';

/** Default lease: 2 minutes, renewed by every batch. */
export const FANOUT_LEASE_MS = 120_000;
/** Enrollees per batch (and notification inserts per transaction). */
export const FANOUT_BATCH_SIZE = 1000;
/** `fanout_jobs_max_attempts_ck`. */
export const MAX_FANOUT_ATTEMPTS_LIMIT = 10;

const MAX_LEASE_MS = 60 * 60 * 1000;
const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

export interface FanoutFence {
  jobId: string;
  workerId: string;
  /** `attempts` returned by the lease (the fencing token). */
  attempt: number;
}

function assertFence(f: FanoutFence): void {
  assertNonEmptyText('workerId', f.workerId, 128);
  assertIntInRange('attempt', f.attempt, 1, MAX_FANOUT_ATTEMPTS_LIMIT);
}

function assertLeaseMs(leaseMs: number): void {
  assertIntInRange('leaseMs', leaseMs, 1_000, MAX_LEASE_MS);
}

export interface EnqueueAnnouncementFanoutInput {
  /** The AnnouncementPosted event id (idempotency key). */
  sourceEventId: string;
  courseId: string;
  announcementId: string;
  sendEmail: boolean;
  /** 1..10; omitted = the column default (5). */
  maxAttempts?: number;
}

/** Idempotent enqueue inside the AnnouncementPosted claim transaction. true = created now. */
export async function enqueueAnnouncementFanout(
  executor: Executor,
  input: EnqueueAnnouncementFanoutInput,
): Promise<boolean> {
  if (input.maxAttempts !== undefined) {
    assertIntInRange('maxAttempts', input.maxAttempts, 1, MAX_FANOUT_ATTEMPTS_LIMIT);
  }
  const result = await sql`
    INSERT INTO notifications.fanout_jobs (kind, source_event_id, course_id, subject_id, send_email, max_attempts)
    VALUES ('ANNOUNCEMENT', ${input.sourceEventId}, ${input.courseId}, ${input.announcementId}, ${input.sendEmail},
            ${input.maxAttempts === undefined ? sql`DEFAULT` : sql`${input.maxAttempts}::int`})
    ON CONFLICT (source_event_id) DO NOTHING
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

export interface LeasedFanoutJob extends FanoutFence {
  kind: 'ANNOUNCEMENT';
  courseId: string;
  announcementId: string;
  sendEmail: boolean;
  sourceEventId: string;
  /** Keyset cursor: continue with enrollees whose user_id > this (null = from the start). */
  afterUserId: string | null;
  maxAttempts: number;
}

/** Leases the oldest due QUEUED job (`FOR UPDATE SKIP LOCKED`). null = nothing due. */
export async function leaseFanoutJob(
  executor: Executor,
  options: { workerId: string; leaseMs?: number },
): Promise<LeasedFanoutJob | null> {
  assertNonEmptyText('workerId', options.workerId, 128);
  const leaseMs = options.leaseMs ?? FANOUT_LEASE_MS;
  assertLeaseMs(leaseMs);
  const { rows } = await sql<{
    id: string;
    attempts: number;
    maxAttempts: number;
    courseId: string;
    subjectId: string;
    sendEmail: boolean;
    afterUserId: string | null;
    sourceEventId: string;
  }>`
    WITH next AS (
      SELECT id FROM notifications.fanout_jobs
       WHERE status = 'QUEUED' AND run_after <= now()
       ORDER BY run_after, id LIMIT 1
       FOR UPDATE SKIP LOCKED)
    UPDATE notifications.fanout_jobs j
       SET status = 'RUNNING', attempts = j.attempts + 1, lease_owner = ${options.workerId},
           lease_expires_at = now() + ${leaseMs}::int * interval '1 millisecond'
      FROM next WHERE j.id = next.id
    RETURNING j.id, j.attempts, j.max_attempts, j.course_id, j.subject_id, j.send_email, j.after_user_id, j.source_event_id
  `.execute(executor);
  const r = rows[0];
  if (r === undefined) return null;
  return {
    jobId: r.id,
    workerId: options.workerId,
    attempt: r.attempts,
    kind: 'ANNOUNCEMENT',
    courseId: r.courseId,
    announcementId: r.subjectId,
    sendEmail: r.sendEmail,
    sourceEventId: r.sourceEventId,
    afterUserId: r.afterUserId,
    maxAttempts: r.maxAttempts,
  };
}

/**
 * First statement of every batch transaction: locks the job row iff the fence still holds.
 * null = the lease was lost (stop, insert nothing). Otherwise the current cursor.
 */
export async function lockFanoutBatch(
  executor: Executor,
  fence: FanoutFence,
): Promise<{ afterUserId: string | null; processedCount: number } | null> {
  assertFence(fence);
  const trx = requireTransaction(executor, 'lockFanoutBatch');
  const { rows } = await sql<{ afterUserId: string | null; processedCount: number }>`
    SELECT after_user_id, processed_count FROM notifications.fanout_jobs
     WHERE id = ${fence.jobId} AND status = 'RUNNING' AND lease_owner = ${fence.workerId} AND attempts = ${fence.attempt}
       FOR UPDATE
  `.execute(trx);
  return rows[0] ?? null;
}

export interface AnnouncementNotificationsInput {
  sourceEventId: string;
  announcementId: string;
  /** Recipients of this batch (<= 1000). */
  userIds: readonly string[];
  /** AnnouncementPayload (contracts), validated by the caller; must carry `redacted: false`. */
  payload: Json;
}

/** Inserts one STUDENT ANNOUNCEMENT row per recipient; returns the users that got a NEW row. */
export async function insertAnnouncementNotifications(
  executor: Executor,
  input: AnnouncementNotificationsInput,
): Promise<string[]> {
  assertIntInRange('userIds.length', input.userIds.length, 0, FANOUT_BATCH_SIZE);
  if (input.userIds.length === 0) return [];
  const { rows } = await sql<{ userId: string }>`
    INSERT INTO notifications.notifications (user_id, app, kind, payload, subject_type, subject_id, source_event_id)
    SELECT u, 'STUDENT', 'ANNOUNCEMENT', ${JSON.stringify(input.payload)}::jsonb, 'ANNOUNCEMENT', ${input.announcementId}::uuid,
           ${input.sourceEventId}::uuid
      FROM unnest(${[...input.userIds]}::uuid[]) AS u
     ORDER BY u
    ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
    RETURNING user_id
  `.execute(executor);
  return rows.map((r) => r.userId);
}

/**
 * Last statement of a batch: advance the cursor and renew the lease, or finish (DONE) when the
 * batch was the last one. Fenced; false = lease lost (roll the batch back).
 */
export async function advanceFanoutJob(
  executor: Executor,
  fence: FanoutFence,
  input: { lastUserId: string | null; processed: number; done: boolean; leaseMs?: number },
): Promise<boolean> {
  assertFence(fence);
  assertIntInRange('processed', input.processed, 0, FANOUT_BATCH_SIZE);
  const leaseMs = input.leaseMs ?? FANOUT_LEASE_MS;
  assertLeaseMs(leaseMs);
  const trx = requireTransaction(executor, 'advanceFanoutJob');
  const cursor = input.lastUserId === null ? sql`after_user_id` : sql`${input.lastUserId}::uuid`;
  const result = input.done
    ? await sql`
        UPDATE notifications.fanout_jobs
           SET after_user_id = ${cursor}, processed_count = processed_count + ${input.processed}::int,
               status = 'DONE', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ${fence.jobId} AND status = 'RUNNING' AND lease_owner = ${fence.workerId} AND attempts = ${fence.attempt}
      `.execute(trx)
    : await sql`
        UPDATE notifications.fanout_jobs
           SET after_user_id = ${cursor}, processed_count = processed_count + ${input.processed}::int,
               lease_expires_at = now() + ${leaseMs}::int * interval '1 millisecond'
         WHERE id = ${fence.jobId} AND status = 'RUNNING' AND lease_owner = ${fence.workerId} AND attempts = ${fence.attempt}
      `.execute(trx);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/**
 * A batch failed for another reason (fenced): back to QUEUED with backoff `2^attempts` minutes,
 * or FAILED once attempts reached max_attempts. null = lease lost.
 */
export async function failFanoutAttempt(
  executor: Executor,
  fence: FanoutFence,
  errorCode: string,
): Promise<'QUEUED' | 'FAILED' | null> {
  assertFence(fence);
  if (!ERROR_CODE_RE.test(errorCode))
    throw new RangeError('errorCode must match ^[a-z0-9_]{1,64}$');
  const { rows } = await sql<{ status: 'QUEUED' | 'FAILED' }>`
    UPDATE notifications.fanout_jobs
       SET status           = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
           finished_at      = CASE WHEN attempts >= max_attempts THEN now() END,
           run_after        = now() + make_interval(mins => (2 ^ attempts)::int),
           last_error_code  = ${errorCode}, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ${fence.jobId} AND status = 'RUNNING' AND lease_owner = ${fence.workerId} AND attempts = ${fence.attempt}
    RETURNING status
  `.execute(executor);
  return rows[0]?.status ?? null;
}

export interface ReapedFanoutLease {
  jobId: string;
  status: 'QUEUED' | 'FAILED';
  attempts: number;
}

/** Reaper (each tick): RUNNING jobs whose lease expired -> QUEUED with backoff, or FAILED. */
export async function reapExpiredFanoutLeases(
  executor: Executor,
  options: { batchSize?: number } = {},
): Promise<ReapedFanoutLease[]> {
  const batchSize = options.batchSize ?? 100;
  assertBatchSize(batchSize);
  const { rows } = await sql<{ id: string; status: 'QUEUED' | 'FAILED'; attempts: number }>`
    UPDATE notifications.fanout_jobs j
       SET status           = CASE WHEN j.attempts >= j.max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
           finished_at      = CASE WHEN j.attempts >= j.max_attempts THEN now() END,
           run_after        = now() + make_interval(mins => (2 ^ j.attempts)::int),
           last_error_code  = 'lease_expired', lease_owner = NULL, lease_expires_at = NULL
      FROM (SELECT id FROM notifications.fanout_jobs
             WHERE status = 'RUNNING' AND lease_expires_at < now()
             ORDER BY lease_expires_at LIMIT ${batchSize}::int
             FOR UPDATE SKIP LOCKED) s
     WHERE j.id = s.id AND j.status = 'RUNNING' AND j.lease_expires_at < now()
    RETURNING j.id, j.status, j.attempts
  `.execute(executor);
  return rows.map((r) => ({ jobId: r.id, status: r.status, attempts: r.attempts }));
}
