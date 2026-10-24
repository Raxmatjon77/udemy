/**
 * Reviews, replies and the rating read model (docs/phase-5-schema-design.md §8.4, D10/D11,
 * races R4/R11).
 *
 * Column-name caveat: `course_rating_stats.count_1..count_5` do not survive Kysely's
 * CamelCasePlugin on writes (`count1` maps back to `count1`, not `count_1`), so this module is
 * the only writer/reader of the histogram and aliases every column explicitly.
 */
import { sql } from 'kysely';
import { assertIntInRange } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';

export type ReviewUpsertOutcome = 'POSTED' | 'EDITED' | 'UNCHANGED';

export interface UpsertReviewResult {
  outcome: ReviewUpsertOutcome;
  reviewId: string;
  /** EDITED: the rating before the edit (ReviewEdited.previousRating); otherwise null. */
  previousRating: number | null;
}

/**
 * UpsertMyReview (R4): one live review per (course, user) through the partial unique
 * `reviews_course_id_user_id_live_uq` as the arbiter (V7) and `RETURNING old.*` (V8).
 * Eligibility (ACTIVE enrollment, >= 1 completed lecture, not the owner) is the caller's job.
 */
export async function upsertReview(
  executor: Executor,
  input: { courseId: string; userId: string; rating: number; body: string | null },
): Promise<UpsertReviewResult> {
  assertIntInRange('rating', input.rating, 1, 5);
  const { rows } = await sql<{ id: string; oldId: string | null; previousRating: number | null }>`
    INSERT INTO engagement.reviews AS r (course_id, user_id, rating, body)
    VALUES (${input.courseId}, ${input.userId}, ${input.rating}, ${input.body})
    ON CONFLICT (course_id, user_id) WHERE deleted_at IS NULL
    DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, edited_at = now()
     WHERE (r.rating, r.body) IS DISTINCT FROM (EXCLUDED.rating, EXCLUDED.body)
    RETURNING r.id, old.id AS old_id, old.rating AS previous_rating
  `.execute(executor);
  const row = rows[0];
  if (row !== undefined) {
    return row.oldId === null
      ? { outcome: 'POSTED', reviewId: row.id, previousRating: null }
      : { outcome: 'EDITED', reviewId: row.id, previousRating: row.previousRating };
  }
  const existing = await sql<{ id: string }>`
    SELECT id FROM engagement.reviews WHERE course_id = ${input.courseId} AND user_id = ${input.userId} AND deleted_at IS NULL
  `.execute(executor);
  return { outcome: 'UNCHANGED', reviewId: existing.rows[0]!.id, previousRating: null };
}

/** UpsertReply: one live reply per review (`review_replies_review_id_live_uq`). Author = course owner (caller). */
export async function upsertReviewReply(
  executor: Executor,
  input: { reviewId: string; authorId: string; body: string },
): Promise<{ outcome: ReviewUpsertOutcome; replyId: string }> {
  const { rows } = await sql<{ id: string; oldId: string | null }>`
    INSERT INTO engagement.review_replies AS r (review_id, author_id, body)
    VALUES (${input.reviewId}, ${input.authorId}, ${input.body})
    ON CONFLICT (review_id) WHERE deleted_at IS NULL
    DO UPDATE SET body = EXCLUDED.body, edited_at = now()
     WHERE r.body IS DISTINCT FROM EXCLUDED.body
    RETURNING r.id, old.id AS old_id
  `.execute(executor);
  const row = rows[0];
  if (row !== undefined) {
    return { outcome: row.oldId === null ? 'POSTED' : 'EDITED', replyId: row.id };
  }
  const existing = await sql<{ id: string }>`
    SELECT id FROM engagement.review_replies WHERE review_id = ${input.reviewId} AND deleted_at IS NULL
  `.execute(executor);
  return { outcome: 'UNCHANGED', replyId: existing.rows[0]!.id };
}

export interface CourseRating {
  courseId: string;
  reviewCount: number;
  /** numeric(2,1) as text ('4.3'); null without reviews. */
  average: string | null;
  /** Histogram of PUBLISHED reviews: index 0 = 1 star ... index 4 = 5 stars. */
  counts: [number, number, number, number, number];
  recomputedAt: Date;
}

interface RatingRow {
  courseId: string;
  reviewCount: number;
  average: string | null;
  c1: number;
  c2: number;
  c3: number;
  c4: number;
  c5: number;
  recomputedAt: Date;
}

const ratingColumns = sql`
  course_id, review_count, average_rating::text AS average,
  count_1 AS c1, count_2 AS c2, count_3 AS c3, count_4 AS c4, count_5 AS c5, recomputed_at`;

function toRating(r: RatingRow): CourseRating {
  return {
    courseId: r.courseId,
    reviewCount: r.reviewCount,
    average: r.average,
    counts: [r.c1, r.c2, r.c3, r.c4, r.c5],
    recomputedAt: r.recomputedAt,
  };
}

/**
 * Worker rating recompute (§8.4, R11): ensure the row, lock it FOR UPDATE (serialises
 * recomputes of one course), then recompute the whole histogram from PUBLISHED reviews in a NEW
 * statement (fresh snapshot after the lock). Self-healing: every event recomputes everything.
 */
export async function recomputeCourseRating(
  executor: Executor,
  courseId: string,
): Promise<CourseRating> {
  const trx = requireTransaction(executor, 'recomputeCourseRating');
  await sql`INSERT INTO engagement.course_rating_stats (course_id) VALUES (${courseId}) ON CONFLICT (course_id) DO NOTHING`.execute(
    trx,
  );
  await sql`SELECT 1 FROM engagement.course_rating_stats WHERE course_id = ${courseId} FOR UPDATE`.execute(
    trx,
  );
  const { rows } = await sql<RatingRow>`
    UPDATE engagement.course_rating_stats s
       SET count_1 = a.c1, count_2 = a.c2, count_3 = a.c3, count_4 = a.c4, count_5 = a.c5, recomputed_at = now()
      FROM (SELECT count(*) FILTER (WHERE rating = 1)::int AS c1, count(*) FILTER (WHERE rating = 2)::int AS c2,
                   count(*) FILTER (WHERE rating = 3)::int AS c3, count(*) FILTER (WHERE rating = 4)::int AS c4,
                   count(*) FILTER (WHERE rating = 5)::int AS c5
              FROM engagement.reviews
             WHERE course_id = ${courseId} AND deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL) a
     WHERE s.course_id = ${courseId}
    RETURNING s.course_id, s.review_count, s.average_rating::text AS average,
              s.count_1 AS c1, s.count_2 AS c2, s.count_3 AS c3, s.count_4 AS c4, s.count_5 AS c5, s.recomputed_at
  `.execute(trx);
  return toRating(rows[0]!);
}

/** GetRatings (batch). A course without a row has no reviews yet (`{ count: 0 }`). */
export async function getCourseRatings(
  executor: Executor,
  courseIds: readonly string[],
): Promise<CourseRating[]> {
  assertIntInRange('courseIds.length', courseIds.length, 0, 1000);
  if (courseIds.length === 0) return [];
  const { rows } = await sql<RatingRow>`
    SELECT ${ratingColumns} FROM engagement.course_rating_stats WHERE course_id = ANY(${[...courseIds]}::uuid[])
  `.execute(executor);
  return rows.map(toRating);
}
