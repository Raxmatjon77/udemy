/**
 * LearningMaintenanceJob SQL (docs/phase-5-schema-design.md §8.7), worker, hourly. Each batch
 * transaction first takes `pg_try_advisory_xact_lock(LEARNING_MAINTENANCE_LOCK_KEY)`
 * (`tryAdvisoryXactLock`); false = another replica is on it, skip the tick.
 */
import { sql } from 'kysely';
import { assertBatchSize, assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';

/**
 * Abandons IN_PROGRESS attempts started more than `ttlHours` ago. `FOR UPDATE SKIP LOCKED` skips
 * an attempt a SUBMIT is holding (R3); the UPDATE re-checks the status. Returns the ids.
 */
export async function abandonStaleQuizAttempts(
  executor: Executor,
  options: { ttlHours: number; batchSize?: number },
): Promise<string[]> {
  assertIntInRange('ttlHours', options.ttlHours, 1, 24 * 30);
  const batchSize = options.batchSize ?? 1000;
  assertBatchSize(batchSize);
  const { rows } = await sql<{ id: string }>`
    UPDATE learning.quiz_attempts a SET status = 'ABANDONED', abandoned_at = now()
      FROM (SELECT id FROM learning.quiz_attempts
             WHERE status = 'IN_PROGRESS' AND started_at < now() - make_interval(hours => ${options.ttlHours}::int)
             ORDER BY started_at LIMIT ${batchSize}::int
             FOR UPDATE SKIP LOCKED) s
     WHERE a.id = s.id AND a.status = 'IN_PROGRESS'
    RETURNING a.id
  `.execute(executor);
  return rows.map((r) => r.id);
}

/** Certificates whose PDF is still missing `olderThanMinutes` after issue (re-render). */
export async function findCertificatesPendingPdf(
  executor: Executor,
  options: { olderThanMinutes?: number; limit?: number } = {},
): Promise<string[]> {
  const olderThanMinutes = options.olderThanMinutes ?? 10;
  const limit = options.limit ?? 100;
  assertIntInRange('olderThanMinutes', olderThanMinutes, 0, 7 * 24 * 60);
  assertBatchSize(limit);
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM learning.certificates
     WHERE pdf_rendered_at IS NULL AND issued_at < now() - make_interval(mins => ${olderThanMinutes}::int)
     ORDER BY issued_at LIMIT ${limit}::int
  `.execute(executor);
  return rows.map((r) => r.id);
}
