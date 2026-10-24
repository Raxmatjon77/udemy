import { Injectable } from '@nestjs/common';
import type { QuizQuestionAuthoring } from '@udemy/contracts';
import { assertValidQuizOptions, type QuizOptionDraft } from '../../domain/quiz';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { QuizRepository } from '../ports/quiz.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { finishQuizWrite, requireQuizLecture, requireQuizQuestion } from '../quiz-support';
import { toQuizQuestionAuthoringView } from '../views';

export interface PutQuizQuestionOptionsInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly questionId: string;
  /** Positions follow the array order. */
  readonly options: readonly QuizOptionDraft[];
}

/**
 * `PutQuizQuestionOptions` (Phase 5 design §5): replaces every option of one question
 * (2–6, distinct texts; 422 `quiz_options_invalid`). The correct-count rule is a readiness
 * issue, not a write error, so a half-done draft can be saved.
 */
@Injectable()
export class PutQuizQuestionOptionsCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: PutQuizQuestionOptionsInput): Promise<QuizQuestionAuthoring> {
    assertValidQuizOptions(input.options);
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await requireQuizLecture(this.curriculum, course.id, input.lectureId, trx);
      await requireQuizQuestion(this.quizzes, lecture.id, input.questionId, trx);
      const question = await this.quizzes.replaceOptions(
        trx,
        lecture.id,
        input.questionId,
        input.options,
      );
      await finishQuizWrite(
        trx,
        { courses: this.courses, quizzes: this.quizzes },
        course,
        lecture.id,
      );
      return toQuizQuestionAuthoringView(question);
    });
  }
}
