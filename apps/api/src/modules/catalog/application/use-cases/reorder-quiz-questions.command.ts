import { Injectable } from '@nestjs/common';
import type { QuizAuthoring } from '@udemy/contracts';
import { planQuizQuestionOrder } from '../../domain/quiz';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { QuizRepository } from '../ports/quiz.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { finishQuizWrite, requireQuiz, requireQuizLecture } from '../quiz-support';
import { toQuizAuthoringView } from '../views';

export interface ReorderQuizQuestionsInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  /** Every current question id exactly once, in the new order. */
  readonly questionIds: readonly string[];
}

/**
 * `ReorderQuizQuestions` (Phase 5 design §5, P2 D3): the full new order, an exact
 * permutation of the current question ids (409 `order_mismatch` otherwise), applied in one
 * statement over the DEFERRED position unique.
 */
@Injectable()
export class ReorderQuizQuestionsCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: ReorderQuizQuestionsInput): Promise<QuizAuthoring> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await requireQuizLecture(this.curriculum, course.id, input.lectureId, trx);
      const current = await this.quizzes.listQuestionIds(trx, lecture.id);
      const positions = planQuizQuestionOrder(current, input.questionIds);
      await this.quizzes.applyQuestionOrder(trx, lecture.id, positions);
      const updated = await finishQuizWrite(
        trx,
        { courses: this.courses, quizzes: this.quizzes },
        course,
        lecture.id,
      );
      return toQuizAuthoringView(
        updated,
        lecture.id,
        await requireQuiz(this.quizzes, lecture.id, trx),
      );
    });
  }
}
