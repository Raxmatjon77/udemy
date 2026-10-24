import { Injectable, Logger } from '@nestjs/common';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  acceptPlayedRanges,
  bucketCountOf,
  bucketSpansOf,
  CoverageBitmap,
  plausibilityBudgetSeconds,
} from '../domain/progress-rules';
import { LearningSettings } from '../application/learning-settings';
import { ProgressRepository } from '../application/ports/progress.repository';
import {
  type LiveLectureProgress,
  ProgressStore,
  type RecordProgressInput,
  type RecordProgressResult,
} from '../application/ports/progress-store';
import { TransactionRunner } from '../application/ports/transaction-runner';

/**
 * `LEARNING_PROGRESS_STORE=direct` (design §12 Q1): one DB upsert per heartbeat, no buffer.
 * The same §8.1 statement as the flush, with one row holding only this heartbeat's buckets:
 * the SQL ORs them into the stored bitmap of the same asset and duration, or replaces an older
 * asset's bitmap (D3); position is last-write-wins on the heartbeat time.
 *
 * The plausibility budget uses the stored `last_watched_at` (two parallel heartbeats of one
 * lecture may both use it; accepted: the budget still needs real wall-clock time).
 */
@Injectable()
export class DirectProgressStore extends ProgressStore {
  private readonly logger = new Logger(DirectProgressStore.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly progress: ProgressRepository,
    private readonly tx: TransactionRunner,
    private readonly settings: LearningSettings,
  ) {
    super();
  }

  async record(input: RecordProgressInput): Promise<RecordProgressResult> {
    const bucketCount = bucketCountOf(input.durationSeconds, this.settings.bucketSeconds);
    const stored = await this.progress.findCoverage(input.userId, input.lectureId);
    const lastMs = stored?.lastWatchedAt.getTime() ?? null;
    const budget = plausibilityBudgetSeconds(lastMs, input.nowMs, this.settings.plausibility);
    const { accepted, droppedSeconds } = acceptPlayedRanges(
      input.ranges,
      input.durationSeconds,
      budget,
    );
    const coverage = CoverageBitmap.empty(bucketCount).withSpans(
      bucketSpansOf(accepted, this.settings.bucketSeconds),
    );
    // Monotonic heartbeat time per row, so last-write-wins never goes backwards on clock skew.
    const at = new Date(Math.max(input.nowMs, lastMs ?? 0));
    const state = await this.tx.run((trx) =>
      this.progress.writeOne(
        trx,
        {
          userId: input.userId,
          lectureId: input.lectureId,
          courseId: input.courseId,
          mediaAssetId: input.mediaAssetId,
          durationSeconds: input.durationSeconds,
          positionSeconds: Math.min(
            Math.max(Math.floor(input.positionSeconds), 0),
            input.durationSeconds,
          ),
          coverage: coverage.toBytes(),
          firstWatchedAt: at,
          lastWatchedAt: at,
        },
        {
          userId: input.userId,
          courseId: input.courseId,
          lectureId: input.lectureId,
          accessedAt: at,
        },
      ),
    );
    const sameAsset =
      state.mediaAssetId === input.mediaAssetId && state.durationSeconds === input.durationSeconds;
    return {
      coveredBuckets: sameAsset ? Math.min(state.coveredBuckets, bucketCount) : 0,
      bucketCount,
      droppedSeconds,
    };
  }

  /** No buffer: the DB rows are current. */
  readBuffered(): Promise<ReadonlyMap<string, LiveLectureProgress>> {
    return Promise.resolve(new Map());
  }

  readBufferedActivity(): Promise<null> {
    return Promise.resolve(null);
  }

  async touchActivity(
    userId: string,
    courseId: string,
    lectureId: string,
    nowMs: number,
  ): Promise<void> {
    try {
      await this.progress.writeActivity(this.db, {
        userId,
        courseId,
        lectureId,
        accessedAt: new Date(nowMs),
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'resume pointer update failed');
    }
  }
}
