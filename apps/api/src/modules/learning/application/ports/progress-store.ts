import type { PlayedRange } from '../../domain/progress-rules';

export interface RecordProgressInput {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  /** The live revision's asset: a different stored asset resets the bitmap (D3). */
  readonly mediaAssetId: string;
  /** The live duration (> 0). */
  readonly durationSeconds: number;
  /** Clamped to the duration by the store. */
  readonly positionSeconds: number;
  /** Played since the last heartbeat, oldest first (≤ 32, whole seconds). */
  readonly ranges: readonly PlayedRange[];
  /** Server time of the heartbeat. */
  readonly nowMs: number;
}

export interface RecordProgressResult {
  /** Covered buckets of the live asset after this heartbeat. */
  readonly coveredBuckets: number;
  readonly bucketCount: number;
  /** Seconds dropped by the plausibility clamp or the duration (observability only). */
  readonly droppedSeconds: number;
}

/** The live progress of one VIDEO lecture (position and coverage of the live asset). */
export interface LiveLectureProgress {
  readonly positionSeconds: number;
  readonly coveredBuckets: number;
  readonly bucketCount: number;
}

/** A live VIDEO lecture whose buffered progress the bootstrap wants. */
export interface VideoLectureRef {
  readonly lectureId: string;
  readonly mediaAssetId: string;
  readonly durationSeconds: number;
}

/**
 * Where heartbeats go (design D2, §12 Q1, `LEARNING_PROGRESS_STORE`):
 *
 * - `RedisProgressStore` (default): write-behind. A heartbeat touches Redis only; the
 *   `ProgressFlushJob` drains the dirty set into Postgres every 15 s.
 * - `DirectProgressStore`: one DB upsert per heartbeat (tests, and the fallback flag).
 *
 * Both apply the same plausibility clamp and bucket rules (domain `progress-rules`), and both
 * return the coverage of the LIVE asset, which the heartbeat compares to the completion
 * threshold. Lecture and course completions are not the store's business: they are written
 * synchronously by the use case (D2).
 */
export abstract class ProgressStore {
  /** Applies one heartbeat. Throws `ProgressStoreUnavailable` (503) when it cannot. */
  abstract record(input: RecordProgressInput): Promise<RecordProgressResult>;

  /**
   * Buffered (not yet flushed) progress of these lectures, keyed by lecture id: only entries
   * measured against the given asset and duration. The direct store has no buffer (empty map).
   * Never throws: an unavailable buffer reads as empty (the DB values are at most one flush old).
   */
  abstract readBuffered(
    userId: string,
    lectures: readonly VideoLectureRef[],
  ): Promise<ReadonlyMap<string, LiveLectureProgress>>;

  /** The buffered resume pointer of (user, course), or null. Never throws. */
  abstract readBufferedActivity(
    userId: string,
    courseId: string,
  ): Promise<{ readonly lectureId: string; readonly atMs: number } | null>;

  /** Moves the resume pointer (completions of non-VIDEO lectures). Best effort: never throws. */
  abstract touchActivity(
    userId: string,
    courseId: string,
    lectureId: string,
    nowMs: number,
  ): Promise<void>;
}
