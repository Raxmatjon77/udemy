/**
 * Engagement consistency queries (docs/phase-5-schema-design.md §8.8): each must return nothing.
 * Run them in integration tests and as an ops check. The optional id lists scope the scan
 * (tests on a shared database); omit them for the full scan.
 */
import { sql } from 'kysely';
import type { Executor } from '../transaction';

function scope(column: string, ids: readonly string[] | undefined) {
  return ids === undefined ? sql`` : sql`AND ${sql.ref(column)} = ANY(${[...ids]}::uuid[])`;
}

/** course_rating_stats rows whose histogram differs from a fresh count of PUBLISHED reviews. */
export async function findRatingStatsDrift(
  executor: Executor,
  options: { courseIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await sql<{ courseId: string }>`
    SELECT s.course_id FROM engagement.course_rating_stats s
      LEFT JOIN (SELECT course_id, count(*) FILTER (WHERE rating = 1) AS c1, count(*) FILTER (WHERE rating = 2) AS c2,
                        count(*) FILTER (WHERE rating = 3) AS c3, count(*) FILTER (WHERE rating = 4) AS c4,
                        count(*) FILTER (WHERE rating = 5) AS c5
                   FROM engagement.reviews
                  WHERE deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL
                  GROUP BY course_id) r USING (course_id)
     WHERE (s.count_1, s.count_2, s.count_3, s.count_4, s.count_5)
           IS DISTINCT FROM (coalesce(r.c1, 0), coalesce(r.c2, 0), coalesce(r.c3, 0), coalesce(r.c4, 0), coalesce(r.c5, 0))
           ${scope('s.course_id', options.courseIds)}
     ORDER BY s.course_id
  `.execute(executor);
  return rows.map((r) => r.courseId);
}

/** Questions whose trigger-maintained counters differ from count(*) (votes; visible, non-deleted answers). */
export async function findQuestionCounterDrift(
  executor: Executor,
  options: { courseIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT q.id FROM engagement.questions q
     WHERE (q.upvote_count <> (SELECT count(*) FROM engagement.question_votes v WHERE v.subject_id = q.id)
        OR q.answer_count <> (SELECT count(*) FROM engagement.answers a
                               WHERE a.question_id = q.id AND a.deleted_at IS NULL AND a.moderation_status = 'VISIBLE')
        OR q.last_activity_at <> greatest(q.created_at, (SELECT max(a.created_at) FROM engagement.answers a
                                                           WHERE a.question_id = q.id AND a.deleted_at IS NULL
                                                             AND a.moderation_status = 'VISIBLE')))
           ${scope('q.course_id', options.courseIds)}
     ORDER BY q.id
  `.execute(executor);
  return rows.map((r) => r.id);
}

/** Answers whose upvote_count differs from their vote rows. */
export async function findAnswerCounterDrift(
  executor: Executor,
  options: { questionIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT a.id FROM engagement.answers a
     WHERE a.upvote_count <> (SELECT count(*) FROM engagement.answer_votes v WHERE v.subject_id = a.id)
           ${scope('a.question_id', options.questionIds)}
     ORDER BY a.id
  `.execute(executor);
  return rows.map((r) => r.id);
}

/** Live reviews whose suspension disagrees with the enrollment (suspended <=> REVOKED, D9). */
export async function findReviewSuspensionDrift(
  executor: Executor,
  options: { userIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT r.id FROM engagement.reviews r
      JOIN enrollment.enrollments e ON e.user_id = r.user_id AND e.course_id = r.course_id
     WHERE r.deleted_at IS NULL AND (r.suspended_at IS NOT NULL) <> (e.status = 'REVOKED')
           ${scope('r.user_id', options.userIds)}
     ORDER BY r.id
  `.execute(executor);
  return rows.map((r) => r.id);
}
