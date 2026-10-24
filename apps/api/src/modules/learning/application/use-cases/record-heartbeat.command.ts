import { Injectable } from '@nestjs/common';
import type { ProgressAck } from '@udemy/contracts';
import { courseProgressOf } from '../../domain/completion-policy';
import { LectureTypeMismatch } from '../../domain/learning.errors';
import { meetsVideoCompletion, type PlayedRange } from '../../domain/progress-rules';
import { CompletionRecorder, progressOfEvaluation } from '../completion-recorder';
import { LearnerAccess, liveLecturesOf } from '../learner-access';
import { LearningSettings } from '../learning-settings';
import { LearningClock } from '../ports/learning-clock';
import { LearningRateLimiter } from '../ports/learning-rate-limiter';
import { LearningRepository } from '../ports/learning.repository';
import { ProgressStore } from '../ports/progress-store';
import { TransactionRunner } from '../ports/transaction-runner';

export interface RecordHeartbeatInput {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly positionSeconds: number;
  /** Played since the last heartbeat, oldest first (whole seconds, ≤ 32; schema-validated). */
  readonly ranges: readonly PlayedRange[];
}

/**
 * `RecordHeartbeat` (design §5, D2-D4; `PUT /me/courses/:courseId/lectures/:lectureId/progress`):
 *
 * 1. Rate limit (40/min per user; the player drops a 429 batch silently).
 * 2. The live lecture (404s), then an ACTIVE enrollment through the 60 s access cache (403).
 * 3. The lecture must be a VIDEO with a duration and an asset (422 `lecture_type_mismatch`).
 * 4. `ProgressStore.record`: plausibility clamp, coverage OR, position (Redis write-behind by
 *    default; 503 when the buffer is unavailable, and the player keeps the batch).
 * 5. Crossing `LEARNING_VIDEO_COMPLETE_PCT` (90 %) on a lecture not yet complete: the
 *    synchronous `CompleteLecture(VIDEO_WATCHED)` transaction (lecture + maybe course
 *    completion + outbox), exact and idempotent under the `lrnc` lock.
 *
 * Returns the state AFTER the heartbeat (not "changed by it").
 */
@Injectable()
export class RecordHeartbeatCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly access: LearnerAccess,
    private readonly store: ProgressStore,
    private readonly completions: LearningRepository,
    private readonly recorder: CompletionRecorder,
    private readonly tx: TransactionRunner,
    private readonly clock: LearningClock,
    private readonly settings: LearningSettings,
  ) {}

  async execute(input: RecordHeartbeatInput): Promise<ProgressAck> {
    await this.rateLimiter.hit('heartbeat', input.userId);
    const curriculum = await this.access.curriculum(input.courseId);
    const lecture = this.access.lecture(curriculum, input.lectureId);
    await this.access.requireLearnerCached(input.userId, curriculum.courseId);
    const duration = lecture.durationSeconds;
    if (lecture.type !== 'VIDEO' || duration === null || duration <= 0 || !lecture.mediaAssetId) {
      throw new LectureTypeMismatch();
    }

    const recorded = await this.store.record({
      userId: input.userId,
      courseId: curriculum.courseId,
      lectureId: lecture.id,
      mediaAssetId: lecture.mediaAssetId,
      durationSeconds: duration,
      positionSeconds: input.positionSeconds,
      ranges: input.ranges,
      nowMs: this.clock.nowMs(),
    });

    const [completedIds, courseCompletion] = await Promise.all([
      this.completions.listCompletedLectureIds(input.userId, curriculum.courseId),
      this.completions.findCourseCompletion(input.userId, curriculum.courseId),
    ]);
    const completed = new Set(completedIds);
    const watched = meetsVideoCompletion(
      recorded.coveredBuckets,
      recorded.bucketCount,
      this.settings.videoCompletePct,
    );
    if (!completed.has(lecture.id) && watched) {
      const outcome = await this.tx.run((trx) =>
        this.recorder.complete(trx, {
          userId: input.userId,
          curriculum,
          lecture,
          cause: 'VIDEO_WATCHED',
        }),
      );
      return {
        lectureCompleted: true,
        courseCompleted: outcome.course.completion !== null,
        coursePct: progressOfEvaluation(outcome.course).pct,
      };
    }
    const progress = courseProgressOf(
      completed,
      liveLecturesOf(curriculum).map((l) => l.id),
    );
    return {
      lectureCompleted: completed.has(lecture.id),
      courseCompleted: courseCompletion !== null,
      coursePct: progress.pct,
    };
  }
}
