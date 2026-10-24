import { Injectable } from '@nestjs/common';
import type { QuizAuthoring } from '@udemy/contracts';
import { CourseNotFound } from '../../domain/catalog.errors';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { QuizRepository } from '../ports/quiz.repository';
import { requireQuiz, requireQuizLecture } from '../quiz-support';
import { toQuizAuthoringView } from '../views';

export interface GetQuizInput {
  readonly courseId: string;
  readonly lectureId: string;
}

/**
 * `GetQuiz` (Phase 5 design §8 instructor): the working-copy quiz of a QUIZ lecture WITH its
 * answer key, for the owner or an admin only (route policy `course:read`, like the
 * curriculum). 404 `course_not_found` / `lecture_not_found`, 422 `lecture_type_mismatch`.
 */
@Injectable()
export class GetQuizQuery {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
  ) {}

  async execute(input: GetQuizInput): Promise<QuizAuthoring> {
    const course = await this.courses.findById(input.courseId);
    if (course === null) throw new CourseNotFound();
    const lecture = await requireQuizLecture(this.curriculum, course.id, input.lectureId);
    return toQuizAuthoringView(course, lecture.id, await requireQuiz(this.quizzes, lecture.id));
  }
}
