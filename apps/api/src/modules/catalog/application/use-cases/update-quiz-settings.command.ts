import { Injectable } from '@nestjs/common';
import type { QuizAuthoring } from '@udemy/contracts';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { QuizRepository } from '../ports/quiz.repository';
import { finishQuizWrite, requireQuiz, requireQuizLecture } from '../quiz-support';
import { TransactionRunner } from '../ports/transaction-runner';
import { toQuizAuthoringView } from '../views';

export interface UpdateQuizSettingsInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  /** 1–100 (request schema; `lecture_quizzes_pass_pct_ck` backs it up). */
  readonly passPct: number;
}

/**
 * `UpdateQuizSettings` (Phase 5 design §5): the pass mark of a QUIZ lecture of the owner's
 * working copy, under the course lock (409 `course_in_review` while pending), bumping the
 * course version. 404, 422 `lecture_type_mismatch`.
 */
@Injectable()
export class UpdateQuizSettingsCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: UpdateQuizSettingsInput): Promise<QuizAuthoring> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await requireQuizLecture(this.curriculum, course.id, input.lectureId, trx);
      await this.quizzes.updatePassPct(trx, lecture.id, input.passPct);
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
