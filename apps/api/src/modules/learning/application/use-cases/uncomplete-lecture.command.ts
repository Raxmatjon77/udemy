import { Injectable } from '@nestjs/common';
import type { CompletionState } from '@udemy/contracts';
import { CompletionRecorder } from '../completion-recorder';
import { LearnerAccess } from '../learner-access';
import { LearningClock } from '../ports/learning-clock';
import { LearningRateLimiter } from '../ports/learning-rate-limiter';
import { LearningRepository } from '../ports/learning.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { readCompletionState } from './completion-state';

export interface UncompleteLectureInput {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
}

/**
 * `UncompleteLecture` (design §5, D4, P5-D3; `DELETE …/completion`): allowed for every type,
 * idempotent (a repeat writes nothing). Deletes the row under the `lrnc` lock and writes
 * `LectureCompletionCleared`; never touches `course_completions` or a certificate. A VIDEO whose
 * coverage is still at the threshold completes again on its next heartbeat (the rule is the
 * coverage, not the tick).
 */
@Injectable()
export class UncompleteLectureCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly access: LearnerAccess,
    private readonly recorder: CompletionRecorder,
    private readonly completions: LearningRepository,
    private readonly tx: TransactionRunner,
    private readonly clock: LearningClock,
  ) {}

  async execute(input: UncompleteLectureInput): Promise<CompletionState> {
    await this.rateLimiter.hit('completionToggle', input.userId);
    const curriculum = await this.access.curriculum(input.courseId);
    const lecture = this.access.lecture(curriculum, input.lectureId);
    await this.access.requireLearner(input.userId, curriculum.courseId);

    return this.tx.run(async (trx) => {
      await this.recorder.clear(
        trx,
        { userId: input.userId, courseId: curriculum.courseId, lectureId: lecture.id },
        new Date(this.clock.nowMs()),
      );
      return readCompletionState(this.completions, trx, input.userId, curriculum, lecture.id);
    });
  }
}
