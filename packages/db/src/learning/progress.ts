/**
 * Progress write-behind SQL (docs/phase-5-schema-design.md §8.1): the ProgressFlushJob batch
 * upsert (api, under LEARNING_PROGRESS_FLUSH_LOCK_KEY taken BEFORE the Redis claim) and the
 * one-row DirectProgressStore write are the same statement.
 *
 * Coverage merge rules (D3):
 * - same media_asset_id AND duration_seconds -> OR (bits only ever grow; commutative, idempotent);
 * - otherwise the newer heartbeat (last_watched_at) replaces the bitmap, asset and duration (reset);
 *   an older batch never overwrites newer data. Position is last-write-wins on last_watched_at.
 * The OR is `p.coverage | learning.fit_coverage(EXCLUDED.coverage, length(p.coverage))`: equal
 * lengths are already guaranteed by the CASE and lecture_progress_coverage_ck, and the extra fit
 * keeps the statement safe even if PG evaluated that branch for a non-matching row (§0 V1/V5).
 *
 * Batches are deduped and sorted by (user_id, lecture_id) so a concurrent DirectProgressStore
 * write cannot deadlock with a flush. A 23514 fails the whole batch: retry row by row and drop
 * (and log) the offending member (§8.1).
 */
import { sql } from 'kysely';
import { assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';
import { coverageHexLiteral, coverageTextToBytes, MAX_PROGRESS_DURATION_SECONDS } from './coverage';

/** Upper bound of one upsert batch (the flush claims <= LEARNING_PROGRESS_FLUSH_BATCH_SIZE = 500). */
export const MAX_PROGRESS_BATCH = 1000;

export interface LectureProgressInput {
  userId: string;
  lectureId: string;
  courseId: string;
  /** Asset the bitmap was measured against (the live revision's asset). */
  mediaAssetId: string;
  /** Live duration snapshot, 1..86400; gives the bitmap its length. */
  durationSeconds: number;
  /** Clamped to 0..durationSeconds in SQL. */
  positionSeconds: number;
  /** Redis `lpc:{u}:{l}` bytes, MSB-first; padded/truncated to the bucket count in SQL. */
  coverage: Uint8Array;
  firstWatchedAt: Date;
  /** Heartbeat time, the last-write-wins key. */
  lastWatchedAt: Date;
}

export interface LectureProgressState {
  userId: string;
  lectureId: string;
  mediaAssetId: string;
  durationSeconds: number;
  positionSeconds: number;
  /** Set bits = watched 5 s buckets. */
  coveredBuckets: number;
  /** = ceil(durationSeconds / 5). */
  bucketCount: number;
  firstWatchedAt: Date;
  lastWatchedAt: Date;
}

function key(r: { userId: string; lectureId: string }): string {
  return `${r.userId.toLowerCase()}:${r.lectureId.toLowerCase()}`;
}

/**
 * Upserts a deduplicated batch (throws RangeError on a duplicate (userId, lectureId): ON CONFLICT
 * cannot touch one row twice) and returns the merged state of every row.
 */
export async function upsertLectureProgress(
  executor: Executor,
  rows: readonly LectureProgressInput[],
): Promise<LectureProgressState[]> {
  assertIntInRange('rows.length', rows.length, 1, MAX_PROGRESS_BATCH);
  const seen = new Set<string>();
  for (const r of rows) {
    assertIntInRange('durationSeconds', r.durationSeconds, 1, MAX_PROGRESS_DURATION_SECONDS);
    if (!Number.isInteger(r.positionSeconds))
      throw new RangeError('positionSeconds must be an integer');
    const k = key(r);
    if (seen.has(k)) throw new RangeError(`duplicate progress row for ${k}`);
    seen.add(k);
  }
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const col = <T>(f: (r: LectureProgressInput) => T): T[] => sorted.map(f);

  const { rows: out } = await sql<LectureProgressState>`
    INSERT INTO learning.lecture_progress AS p
           (user_id, lecture_id, course_id, media_asset_id, duration_seconds, position_seconds, coverage,
            first_watched_at, last_watched_at)
    SELECT b.user_id, b.lecture_id, b.course_id, b.media_asset_id, b.duration_seconds,
           least(greatest(b.position_seconds, 0), b.duration_seconds),
           learning.fit_coverage(b.coverage_hex::varbit, (b.duration_seconds + 4) / 5),
           b.first_at, b.last_at
      FROM unnest(${col((r) => r.userId)}::uuid[], ${col((r) => r.lectureId)}::uuid[],
                  ${col((r) => r.courseId)}::uuid[], ${col((r) => r.mediaAssetId)}::uuid[],
                  ${col((r) => r.durationSeconds)}::int[], ${col((r) => r.positionSeconds)}::int[],
                  ${col((r) => coverageHexLiteral(r.coverage))}::text[],
                  ${col((r) => r.firstWatchedAt.toISOString())}::timestamptz[],
                  ${col((r) => r.lastWatchedAt.toISOString())}::timestamptz[])
           AS b(user_id, lecture_id, course_id, media_asset_id, duration_seconds, position_seconds, coverage_hex,
                first_at, last_at)
     ORDER BY b.user_id, b.lecture_id
    ON CONFLICT (user_id, lecture_id) DO UPDATE SET
      coverage = CASE
                   WHEN p.media_asset_id = EXCLUDED.media_asset_id AND p.duration_seconds = EXCLUDED.duration_seconds
                     THEN p.coverage | learning.fit_coverage(EXCLUDED.coverage, length(p.coverage))
                   WHEN EXCLUDED.last_watched_at >= p.last_watched_at
                     THEN EXCLUDED.coverage
                   ELSE p.coverage
                 END,
      media_asset_id   = CASE WHEN EXCLUDED.last_watched_at >= p.last_watched_at THEN EXCLUDED.media_asset_id   ELSE p.media_asset_id   END,
      duration_seconds = CASE WHEN EXCLUDED.last_watched_at >= p.last_watched_at THEN EXCLUDED.duration_seconds ELSE p.duration_seconds END,
      position_seconds = CASE WHEN EXCLUDED.last_watched_at >= p.last_watched_at THEN EXCLUDED.position_seconds ELSE p.position_seconds END,
      first_watched_at = least(p.first_watched_at, EXCLUDED.first_watched_at),
      last_watched_at  = greatest(p.last_watched_at, EXCLUDED.last_watched_at)
    RETURNING user_id, lecture_id, media_asset_id, duration_seconds, position_seconds,
              learning.coverage_bits(coverage) AS covered_buckets, length(coverage) AS bucket_count,
              first_watched_at, last_watched_at
  `.execute(executor);
  return out;
}

export interface CourseActivityInput {
  userId: string;
  courseId: string;
  lectureId: string;
  accessedAt: Date;
}

/** Monotonic resume-pointer upsert (only a newer accessedAt wins). Returns the rows written. */
export async function upsertCourseActivity(
  executor: Executor,
  rows: readonly CourseActivityInput[],
): Promise<number> {
  assertIntInRange('rows.length', rows.length, 1, MAX_PROGRESS_BATCH);
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.userId.toLowerCase()}:${r.courseId.toLowerCase()}`;
    if (seen.has(k)) throw new RangeError(`duplicate course activity row for ${k}`);
    seen.add(k);
  }
  const result = await sql`
    INSERT INTO learning.course_activity AS a (user_id, course_id, last_lecture_id, last_accessed_at)
    SELECT * FROM unnest(${rows.map((r) => r.userId)}::uuid[], ${rows.map((r) => r.courseId)}::uuid[],
                         ${rows.map((r) => r.lectureId)}::uuid[],
                         ${rows.map((r) => r.accessedAt.toISOString())}::timestamptz[])
     ORDER BY 1, 2
    ON CONFLICT (user_id, course_id) DO UPDATE
       SET last_lecture_id = EXCLUDED.last_lecture_id, last_accessed_at = EXCLUDED.last_accessed_at
     WHERE EXCLUDED.last_accessed_at > a.last_accessed_at
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n);
}

export interface StoredLectureProgress extends LectureProgressState {
  courseId: string;
}

/** Player bootstrap / progress page: every progress row of (user, course) without the bitmap. */
export async function listCourseLectureProgress(
  executor: Executor,
  userId: string,
  courseId: string,
): Promise<StoredLectureProgress[]> {
  const { rows } = await sql<StoredLectureProgress>`
    SELECT user_id, lecture_id, course_id, media_asset_id, duration_seconds, position_seconds,
           learning.coverage_bits(coverage) AS covered_buckets, length(coverage) AS bucket_count,
           first_watched_at, last_watched_at
      FROM learning.lecture_progress
     WHERE user_id = ${userId} AND course_id = ${courseId}
     ORDER BY lecture_id
  `.execute(executor);
  return rows;
}

export interface LectureCoverage {
  mediaAssetId: string;
  durationSeconds: number;
  positionSeconds: number;
  bucketCount: number;
  /** MSB-first bytes for `SET lpc:{u}:{l}` (Redis miss); bit i = bucket i. */
  coverage: Uint8Array;
  lastWatchedAt: Date;
}

/** The stored bitmap of one (user, lecture), for re-seeding Redis on a miss. null = none yet. */
export async function getLectureCoverage(
  executor: Executor,
  userId: string,
  lectureId: string,
): Promise<LectureCoverage | null> {
  const { rows } = await sql<Omit<LectureCoverage, 'coverage'> & { coverageText: string }>`
    SELECT media_asset_id, duration_seconds, position_seconds, length(coverage) AS bucket_count,
           coverage::text AS coverage_text, last_watched_at
      FROM learning.lecture_progress
     WHERE user_id = ${userId} AND lecture_id = ${lectureId}
  `.execute(executor);
  const row = rows[0];
  if (row === undefined) return null;
  const { coverageText, ...rest } = row;
  return { ...rest, coverage: coverageTextToBytes(coverageText) };
}

/** Resume pointer of (user, course). */
export async function getCourseActivity(
  executor: Executor,
  userId: string,
  courseId: string,
): Promise<{ lastLectureId: string; lastAccessedAt: Date } | null> {
  const { rows } = await sql<{ lastLectureId: string; lastAccessedAt: Date }>`
    SELECT last_lecture_id, last_accessed_at FROM learning.course_activity
     WHERE user_id = ${userId} AND course_id = ${courseId}
  `.execute(executor);
  return rows[0] ?? null;
}
