import { LEARNING_PROGRESS_RULES } from '@udemy/contracts';
import type { PlausibilityRules } from '../domain/progress-rules';

export type ProgressStoreKind = 'redis' | 'direct';

/**
 * Learning configuration (design D2-D4, §14 "Configuration (P5-T3)"), built once from the
 * validated `LEARNING_*` env by the module factory. Plain values: use cases and tests construct
 * it directly.
 */
export class LearningSettings {
  /** Plausibility clamp (D3): the contracts' published rules, so client and server agree. */
  readonly plausibility: PlausibilityRules = Object.freeze({
    factor: LEARNING_PROGRESS_RULES.plausibilityFactor,
    slackSeconds: LEARNING_PROGRESS_RULES.plausibilitySlackSeconds,
    firstSeconds: LEARNING_PROGRESS_RULES.plausibilityFirstSeconds,
  });

  constructor(
    /** `LEARNING_PROGRESS_STORE`: Redis write-behind (default) or a DB upsert per heartbeat. */
    readonly progressStore: ProgressStoreKind,
    /** `LEARNING_JOBS_ENABLED`: run ProgressFlushJob (and its final flush on shutdown) here. */
    readonly jobsEnabled: boolean,
    /** `LEARNING_PROGRESS_FLUSH_INTERVAL_MS` (15 000). */
    readonly flushIntervalMs: number,
    /** `LEARNING_PROGRESS_FLUSH_BATCH_SIZE` (500): dirty entries claimed per flush batch. */
    readonly flushBatchSize: number,
    /** `LEARNING_COVERAGE_BUCKET_S` (5). */
    readonly bucketSeconds: number,
    /** `LEARNING_VIDEO_COMPLETE_PCT` (90). */
    readonly videoCompletePct: number,
  ) {}

  /**
   * A claim older than this belongs to a flusher that crashed (or lost Redis) between claim
   * and ack: the next flush re-queues it. Far above one batch's run time, so a live flusher's
   * claim is never taken over (and if it were, re-flushing is harmless: OR / last-write-wins).
   */
  get staleClaimMs(): number {
    return Math.max(60_000, this.flushIntervalMs * 4);
  }

  /** Batches per tick before yielding to the next interval (bounds one tick's work). */
  get maxBatchesPerTick(): number {
    return 20;
  }
}
