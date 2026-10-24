/**
 * Learning advisory locks (docs/phase-5-schema-design.md §10).
 *
 * Lock order (§6, a path may skip steps, never reverse them):
 *   lrnc / note advisory -> aggregate row (attempt / certificate) -> child rows
 * Every learning transaction runs at READ COMMITTED (lock first, read in a new statement).
 */
import { sql } from 'kysely';
import { advisoryXactLock2, uuidLockKey } from '../internal/advisory';
import type { Executor } from '../transaction';

/**
 * `pg_try_advisory_xact_lock` key of the api ProgressFlushJob (`0x75646d79_06`). Taken BEFORE
 * the Redis claim; false = skip the tick and claim nothing (R5).
 */
export const LEARNING_PROGRESS_FLUSH_LOCK_KEY = 0x75646d79_06;
/** `pg_try_advisory_xact_lock` key of the worker LearningMaintenanceJob (`0x75646d79_08`). */
export const LEARNING_MAINTENANCE_LOCK_KEY = 0x75646d79_08;

/** First key of the per-(user, course) completion mutex: `'lrnc'` (0x6c726e63). */
export const LEARNING_COMPLETION_LOCK_CLASS = 1819438691;
/** First key of the per-(user, course) notes-cap mutex: `'note'` (0x6e6f7465). */
export const NOTES_CAP_LOCK_CLASS = 1852798053;

/**
 * The `lrnc` mutex: every lecture-completion write and EvaluateCourseCompletion of one
 * (user, course) take it first (R1). Waits; released at COMMIT/ROLLBACK.
 */
export async function lockLearningCompletion(
  executor: Executor,
  userId: string,
  courseId: string,
): Promise<void> {
  await advisoryXactLock2(
    executor,
    LEARNING_COMPLETION_LOCK_CLASS,
    uuidLockKey(userId, courseId),
    'lockLearningCompletion',
  );
}

/**
 * The `note` mutex, then the note count of (user, course) in a new statement (index-only on
 * notes_user_id_course_id_created_at_id_idx). The caller rejects at `LEARNING_LIMITS.maxNotesPerCourse`.
 */
export async function lockNotesCap(
  executor: Executor,
  userId: string,
  courseId: string,
): Promise<{ noteCount: number }> {
  await advisoryXactLock2(
    executor,
    NOTES_CAP_LOCK_CLASS,
    uuidLockKey(userId, courseId),
    'lockNotesCap',
  );
  const { rows } = await sql<{ noteCount: number }>`
    SELECT count(*)::int AS note_count FROM learning.notes WHERE user_id = ${userId} AND course_id = ${courseId}
  `.execute(executor);
  return { noteCount: rows[0]?.noteCount ?? 0 };
}
