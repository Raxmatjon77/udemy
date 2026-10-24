import { Injectable } from '@nestjs/common';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { QuizRepository } from '../ports/quiz.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { finishQuizWrite, requireQuizLecture, requireQuizQuestion } from '../quiz-support';

export interface DeleteQuizQuestionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly questionId: string;
}

/**
 * `DeleteQuizQuestion` (Phase 5 design §5): removes one question of THIS quiz (its options
 * cascade) and closes the position gap. 404 `quiz_question_not_found`, 409 `course_in_review`.
 */
@Injectable()
export class DeleteQuizQuestionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: DeleteQuizQuestionInput): Promise<void> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await requireQuizLecture(this.curriculum, course.id, input.lectureId, trx);
      await requireQuizQuestion(this.quizzes, lecture.id, input.questionId, trx);
      await this.quizzes.deleteQuestion(trx, lecture.id, input.questionId);
      await finishQuizWrite(
        trx,
        { courses: this.courses, quizzes: this.quizzes },
        course,
        lecture.id,
      );
    });
  }
}
