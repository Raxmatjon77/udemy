import { Injectable } from '@nestjs/common';
import type { ClientCompletionCause, CompletionState } from '@udemy/contracts';
import { assertClientCompletionAllowed } from '../../domain/completion-policy';
import { CompletionRecorder } from '../completion-recorder';
import { LearnerAccess } from '../learner-access';
import { LearningClock } from '../ports/learning-clock';
import { LearningRateLimiter } from '../ports/learning-rate-limiter';
import { LearningRepository } from '../ports/learning.repository';
import { ProgressStore } from '../ports/progress-store';
import { TransactionRunner } from '../ports/transaction-runner';
import { readCompletionState } from './completion-state';

export interface CompleteLectureCommandInput {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly cause: ClientCompletionCause;
}

/**
 * `CompleteLecture` from the client (design §5, D4, P5-D3;
 * `POST /me/courses/:courseId/lectures/:lectureId/completion {cause}`): ARTICLE by
 * `ARTICLE_READ` or `MANUAL`, RESOURCE by `RESOURCE_OPENED` or `MANUAL`. VIDEO and QUIZ are
 * measured by the server: 422 `completion_not_allowed`. Idempotent: a repeat returns 200 with
 * the same state and writes no event. 120 toggles per hour.
 */
@Injectable()
export class CompleteLectureCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly access: LearnerAccess,
    private readonly recorder: CompletionRecorder,
    private readonly completions: LearningRepository,
    private readonly store: ProgressStore,
    private readonly tx: TransactionRunner,
    private readonly clock: LearningClock,
  ) {}

  async execute(input: CompleteLectureCommandInput): Promise<CompletionState> {
    await this.rateLimiter.hit('completionToggle', input.userId);
    const curriculum = await this.access.curriculum(input.courseId);
    const lecture = this.access.lecture(curriculum, input.lectureId);
    await this.access.requireLearner(input.userId, curriculum.courseId);
    assertClientCompletionAllowed(lecture.type, input.cause);

    const state = await this.tx.run(async (trx) => {
      await this.recorder.complete(trx, {
        userId: input.userId,
        curriculum,
        lecture,
        cause: input.cause,
      });
      return readCompletionState(this.completions, trx, input.userId, curriculum, lecture.id);
    });
    // The resume pointer follows the lecture the learner just finished (best effort).
    await this.store.touchActivity(
      input.userId,
      curriculum.courseId,
      lecture.id,
      this.clock.nowMs(),
    );
    return state;
  }
}
