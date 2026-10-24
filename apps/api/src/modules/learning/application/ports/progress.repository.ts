import type { DB, Executor, Transaction } from '@udemy/db';

/** One (user, lecture) row for the progress upsert (`@udemy/db` `LectureProgressInput`). */
export interface ProgressRow {
  readonly userId: string;
  readonly lectureId: string;
  readonly courseId: string;
  readonly mediaAssetId: string;
  readonly durationSeconds: number;
  readonly positionSeconds: number;
  /** MSB-first bucket bytes; OR-merged in SQL when the asset and duration match. */
  readonly coverage: Uint8Array;
  readonly firstWatchedAt: Date;
  /** The last-write-wins key (position, and the asset reset of D3). */
  readonly lastWatchedAt: Date;
}

/** One (user, course) resume pointer (`course_activity`, only a newer one wins). */
export interface ActivityRow {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly accessedAt: Date;
}

/** The merged state of a row after an upsert. */
export interface StoredProgress {
  readonly userId: string;
  readonly lectureId: string;
  readonly mediaAssetId: string;
  readonly durationSeconds: number;
  readonly positionSeconds: number;
  readonly coveredBuckets: number;
  readonly bucketCount: number;
  readonly lastWatchedAt: Date;
}

/** A stored bitmap, for seeding the Redis buffer on a miss (and the direct store's budget). */
export interface StoredCoverage {
  readonly mediaAssetId: string;
  readonly durationSeconds: number;
  readonly positionSeconds: number;
  readonly coverage: Uint8Array;
  readonly firstWatchedAt: Date | null;
  readonly lastWatchedAt: Date;
}

export interface ProgressBatchResult {
  /** Progress rows written. */
  readonly written: number;
  /** `{userId}:{lectureId}` of progress rows rejected by a CHECK (dropped and logged, §8.1). */
  readonly dropped: readonly string[];
}

/**
 * `learning.lecture_progress` / `course_activity` through the `@udemy/db` §8.1 SQL: the flush
 * batch (under `LEARNING_PROGRESS_FLUSH_LOCK_KEY`) and the direct store's one-row write are the
 * same statement (coverage OR when the asset and duration match, position last-write-wins).
 */
export abstract class ProgressRepository {
  /** `pg_try_advisory_xact_lock(0x75646d79_06)`: false = another replica is flushing. */
  abstract tryLockFlush(trx: Transaction<DB>): Promise<boolean>;

  /**
   * The flush batch: progress rows (deduped and sorted by the SQL helper, chunked to its batch
   * cap) and activity rows. A CHECK violation (23514) retries row by row under savepoints and
   * drops the offending rows; any other error rolls the whole transaction back.
   */
  abstract writeBatch(
    trx: Transaction<DB>,
    progress: readonly ProgressRow[],
    activity: readonly ActivityRow[],
  ): Promise<ProgressBatchResult>;

  /** The direct store: one row plus its activity, returning the merged state. */
  abstract writeOne(
    trx: Transaction<DB>,
    progress: ProgressRow,
    activity: ActivityRow,
  ): Promise<StoredProgress>;

  /** Resume pointer only (a completion of a non-VIDEO lecture with the direct store). */
  abstract writeActivity(ex: Executor, activity: ActivityRow): Promise<void>;

  /** The stored bitmap of one (user, lecture), or null when never watched. */
  abstract findCoverage(
    userId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<StoredCoverage | null>;

  /** Every stored progress row of (user, course), without the bitmap. */
  abstract listCourseProgress(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<readonly (StoredProgress & { readonly courseId: string })[]>;

  abstract findActivity(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<{ readonly lectureId: string; readonly accessedAt: Date } | null>;
}
