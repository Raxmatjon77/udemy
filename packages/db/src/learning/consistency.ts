/**
 * Learning <-> enrollment consistency (docs/phase-5-schema-design.md §8.8). Must return nothing
 * once the worker has drained; run in ITs and as an ops check. `userIds` scopes the scan.
 */
import { sql } from 'kysely';
import type { Executor } from '../transaction';

function userScope(column: string, userIds: readonly string[] | undefined) {
  return userIds === undefined ? sql`` : sql`AND ${sql.ref(column)} = ANY(${[...userIds]}::uuid[])`;
}

/**
 * Certificates whose ACTIVE-ness disagrees with the enrollment (P5-D7), ignoring certificates
 * with an ADMIN transition (an admin decision overrides the automatic rule).
 */
export async function findCertificateEnrollmentDrift(
  executor: Executor,
  options: { userIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT c.id FROM learning.certificates c
      JOIN enrollment.enrollments e ON e.user_id = c.user_id AND e.course_id = c.course_id
     WHERE (c.status = 'ACTIVE') <> (e.status = 'ACTIVE') ${userScope('c.user_id', options.userIds)}
       AND NOT EXISTS (SELECT 1 FROM learning.certificate_transitions t WHERE t.certificate_id = c.id AND t.cause = 'ADMIN')
     ORDER BY c.id
  `.execute(executor);
  return rows.map((r) => r.id);
}

/** Lecture-progress rows whose bitmap length does not match the duration (impossible while the CHECK holds). */
export async function findMalformedCoverage(
  executor: Executor,
  options: { userIds?: readonly string[] } = {},
): Promise<{ userId: string; lectureId: string }[]> {
  const { rows } = await sql<{ userId: string; lectureId: string }>`
    SELECT user_id, lecture_id FROM learning.lecture_progress
     WHERE length(coverage) <> (duration_seconds + 4) / 5 ${userScope('user_id', options.userIds)}
     ORDER BY user_id, lecture_id
  `.execute(executor);
  return rows;
}
