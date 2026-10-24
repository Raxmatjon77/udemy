/**
 * Consumption figures for the refund policy (docs/phase-5-schema-design.md §8.3, P5-D6), read by
 * commerce's LearningConsumptionPolicy INSIDE the refund transaction (after the cart and order
 * locks). Reads only, takes no locks; at most one flush (<= 15 s) behind Redis, which is fine
 * for a NEEDS_REVIEW signal.
 *
 * Only bitmaps measured against the live asset and duration count (D3): a re-uploaded video
 * starts from zero.
 */
import { sql } from 'kysely';
import { assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';
import { type LectureType, MAX_LIVE_LECTURES } from './completion';

export interface LiveLecture {
  lectureId: string;
  type: LectureType;
  /** VIDEO/RESOURCE: the live asset; null otherwise. */
  mediaAssetId: string | null;
  /** VIDEO: live duration in seconds; null otherwise. */
  durationSeconds: number | null;
}

export interface LearningConsumption {
  videoSecondsWatched: number;
  videoSecondsTotal: number;
  completedLectures: number;
  totalLectures: number;
  courseCompletedAt: Date | null;
  certificateStatus: 'ACTIVE' | 'REVOKED' | null;
}

export async function getLearningConsumption(
  executor: Executor,
  input: { userId: string; courseId: string; lectures: readonly LiveLecture[] },
): Promise<LearningConsumption> {
  assertIntInRange('lectures.length', input.lectures.length, 0, MAX_LIVE_LECTURES);
  const ls = input.lectures;
  const { rows } = await sql<LearningConsumption>`
    WITH live AS (
      SELECT * FROM unnest(${ls.map((l) => l.lectureId)}::uuid[], ${ls.map((l) => l.type)}::text[],
                           ${ls.map((l) => l.mediaAssetId)}::uuid[], ${ls.map((l) => l.durationSeconds)}::int[])
             AS l(lecture_id, type, media_asset_id, duration_seconds))
    SELECT
      (SELECT coalesce(sum(least(learning.coverage_bits(p.coverage) * 5, l.duration_seconds)), 0)::int
         FROM live l
         JOIN learning.lecture_progress p
           ON p.user_id = ${input.userId} AND p.lecture_id = l.lecture_id
          AND p.media_asset_id = l.media_asset_id AND p.duration_seconds = l.duration_seconds
        WHERE l.type = 'VIDEO')                                                          AS video_seconds_watched,
      (SELECT coalesce(sum(duration_seconds), 0)::int FROM live WHERE type = 'VIDEO')    AS video_seconds_total,
      (SELECT count(*)::int FROM learning.lecture_completions c JOIN live l ON l.lecture_id = c.lecture_id
        WHERE c.user_id = ${input.userId} AND c.course_id = ${input.courseId})          AS completed_lectures,
      (SELECT count(*)::int FROM live)                                                   AS total_lectures,
      (SELECT completed_at FROM learning.course_completions
        WHERE user_id = ${input.userId} AND course_id = ${input.courseId})              AS course_completed_at,
      (SELECT status FROM learning.certificates
        WHERE user_id = ${input.userId} AND course_id = ${input.courseId})              AS certificate_status
  `.execute(executor);
  return rows[0]!;
}

/**
 * P5-D6 decision with integer arithmetic (no floats), strict `>`, in this order:
 * an ACTIVE certificate, then video watched, then lectures completed. null = no objection.
 * `pct` = COMMERCE_REFUND_REVIEW_CONSUMED_PCT (default 30).
 */
export function consumptionReviewReason(c: LearningConsumption, pct: number): string | null {
  assertIntInRange('pct', pct, 0, 100);
  if (c.certificateStatus === 'ACTIVE') return 'certificate_issued';
  if (c.videoSecondsTotal > 0 && c.videoSecondsWatched * 100 > pct * c.videoSecondsTotal) {
    return `consumed_video_${Math.floor((c.videoSecondsWatched * 100) / c.videoSecondsTotal)}`;
  }
  if (c.totalLectures > 0 && c.completedLectures * 100 > pct * c.totalLectures) {
    return `consumed_lectures_${Math.floor((c.completedLectures * 100) / c.totalLectures)}`;
  }
  return null;
}
