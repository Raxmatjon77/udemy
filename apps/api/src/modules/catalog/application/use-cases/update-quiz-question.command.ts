import { Injectable } from '@nestjs/common';
import type { QuizQuestionAuthoring } from '@udemy/contracts';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { type QuizQuestionPatch, QuizRepository } from '../ports/quiz.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { finishQuizWrite, requireQuizLecture, requireQuizQuestion } from '../quiz-support';
import { toQuizQuestionAuthoringView } from '../views';

export interface UpdateQuizQuestionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly questionId: string;
  /** undefined = keep; `explanationMd: null` clears the explanation. */
  readonly patch: QuizQuestionPatch;
}

/**
 * `UpdateQuizQuestion` (Phase 5 design §5): kind, prompt and explanation of one question of
 * THIS quiz (another quiz's question is 404 `quiz_question_not_found`). Changing the kind
 * keeps the options; readiness re-checks the correct count. 422 `markdown_not_allowed`.
 */
@Injectable()
export class UpdateQuizQuestionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: UpdateQuizQuestionInput): Promise<QuizQuestionAuthoring> {
    if (input.patch.promptMd !== undefined) assertMarkdownAllowed('promptMd', input.patch.promptMd);
    const explanation = input.patch.explanationMd;
    if (explanation !== undefined && explanation !== null) {
      assertMarkdownAllowed('explanationMd', explanation);
    }
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await requireQuizLecture(this.curriculum, course.id, input.lectureId, trx);
      await requireQuizQuestion(this.quizzes, lecture.id, input.questionId, trx);
      const question = await this.quizzes.updateQuestion(
        trx,
        lecture.id,
        input.questionId,
        input.patch,
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
