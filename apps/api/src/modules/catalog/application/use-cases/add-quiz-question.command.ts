import { Injectable } from '@nestjs/common';
import type { QuizQuestionAuthoring, QuizQuestionKind } from '@udemy/contracts';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { assertCanAddQuizQuestion } from '../../domain/quiz';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { QuizRepository } from '../ports/quiz.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { finishQuizWrite, requireQuizLecture } from '../quiz-support';
import { toQuizQuestionAuthoringView } from '../views';

export interface AddQuizQuestionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly kind: QuizQuestionKind;
  /** Markdown, 1–2000 (stored verbatim). */
  readonly promptMd: string;
  /** Markdown, 1–2000; shown to learners only after passing (Q5). */
  readonly explanationMd?: string | undefined;
}

/**
 * `AddQuizQuestion` (Phase 5 design §5): appends a question without options (they are set
 * with `PutQuizQuestionOptions`) to a QUIZ lecture of the owner's working copy. 422
 * `markdown_not_allowed` / `quiz_limit_exceeded` (≤ 50) / `lecture_type_mismatch`, 409
 * `course_in_review`, 404.
 */
@Injectable()
export class AddQuizQuestionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: AddQuizQuestionInput): Promise<QuizQuestionAuthoring> {
    assertMarkdownAllowed('promptMd', input.promptMd);
    if (input.explanationMd !== undefined) {
      assertMarkdownAllowed('explanationMd', input.explanationMd);
    }
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await requireQuizLecture(this.curriculum, course.id, input.lectureId, trx);
      const count = (await this.quizzes.listQuestionIds(trx, lecture.id)).length;
      assertCanAddQuizQuestion(count);
      const question = await this.quizzes.insertQuestion(trx, {
        lectureId: lecture.id,
        position: count,
        kind: input.kind,
        promptMd: input.promptMd,
        explanationMd: input.explanationMd ?? null,
      });
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
