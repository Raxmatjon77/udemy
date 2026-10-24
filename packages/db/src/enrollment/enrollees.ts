/**
 * Enrollee keyset reader for the announcement fan-out (docs/phase-5-schema-design.md §8.6,
 * open point 6): `enrollments_course_id_user_id_active_idx` (0005) serves
 * `course_id = $1 AND status = 'ACTIVE' AND user_id > $cursor ORDER BY user_id`.
 */
import { sql } from 'kysely';
import { assertBatchSize } from '../internal/assert';
import type { Executor } from '../transaction';

/** ACTIVE enrollees of a course with user_id > `afterUserId` (null = from the start), ascending. */
export async function listActiveEnrolleesAfter(
  executor: Executor,
  courseId: string,
  afterUserId: string | null,
  limit: number,
): Promise<string[]> {
  assertBatchSize(limit);
  const { rows } = await sql<{ userId: string }>`
    SELECT user_id FROM enrollment.enrollments
     WHERE course_id = ${courseId} AND status = 'ACTIVE'
       ${afterUserId === null ? sql`` : sql`AND user_id > ${afterUserId}::uuid`}
     ORDER BY user_id
     LIMIT ${limit}::int
  `.execute(executor);
  return rows.map((r) => r.userId);
}
