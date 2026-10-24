/**
 * NotificationRetentionJob SQL (docs/phase-5-schema-design.md §8.7), worker, daily. Each batch
 * transaction first takes `pg_try_advisory_xact_lock(NOTIFICATION_RETENTION_LOCK_KEY)`
 * (`tryAdvisoryXactLock`); false = another replica is on it. Loop until a batch deletes fewer
 * rows than `batchSize`.
 */
import { sql } from 'kysely';
import { assertBatchSize, assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';

/** `pg_try_advisory_xact_lock` key of the worker NotificationRetentionJob (`0x75646d79_07`). */
export const NOTIFICATION_RETENTION_LOCK_KEY = 0x75646d79_07;
/** Inbox rows older than this are deleted (contracts: notification retention). */
export const NOTIFICATION_RETENTION_DAYS = 180;
/** Finished (DONE/FAILED) fan-out jobs older than this are deleted. */
export const FANOUT_JOB_RETENTION_DAYS = 30;

/** One batch of inbox rows older than `retentionDays` (oldest first). Returns the count deleted. */
export async function deleteExpiredNotifications(
  executor: Executor,
  options: { retentionDays?: number; batchSize?: number } = {},
): Promise<number> {
  const retentionDays = options.retentionDays ?? NOTIFICATION_RETENTION_DAYS;
  const batchSize = options.batchSize ?? 5000;
  assertIntInRange('retentionDays', retentionDays, 1, 3650);
  assertBatchSize(batchSize);
  const result = await sql`
    DELETE FROM notifications.notifications
     WHERE id IN (SELECT id FROM notifications.notifications
                   WHERE created_at < now() - make_interval(days => ${retentionDays}::int)
                   ORDER BY created_at LIMIT ${batchSize}::int)
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n);
}

/** One batch of finished fan-out jobs older than `retentionDays`. Returns the count deleted. */
export async function deleteFinishedFanoutJobs(
  executor: Executor,
  options: { retentionDays?: number; batchSize?: number } = {},
): Promise<number> {
  const retentionDays = options.retentionDays ?? FANOUT_JOB_RETENTION_DAYS;
  const batchSize = options.batchSize ?? 1000;
  assertIntInRange('retentionDays', retentionDays, 1, 3650);
  assertBatchSize(batchSize);
  const result = await sql`
    DELETE FROM notifications.fanout_jobs
     WHERE id IN (SELECT id FROM notifications.fanout_jobs
                   WHERE finished_at < now() - make_interval(days => ${retentionDays}::int)
                   ORDER BY finished_at LIMIT ${batchSize}::int)
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n);
}
