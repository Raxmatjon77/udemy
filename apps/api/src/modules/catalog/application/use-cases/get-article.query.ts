import { Injectable } from '@nestjs/common';
import type { Article } from '@udemy/contracts';
import { CourseNotFound, LectureNotFound } from '../../domain/catalog.errors';
import { assertArticleLecture } from '../../domain/curriculum';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { toArticleView } from '../views';

export interface GetArticleInput {
  readonly courseId: string;
  readonly lectureId: string;
}

/**
 * `GetArticle` (design §5): the working-copy markdown of an ARTICLE lecture of this course
 * (owner or admin; 422 `lecture_type_mismatch` for other types). Never saved: empty body,
 * `updatedAt` null.
 */
@Injectable()
export class GetArticleQuery {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
  ) {}

  async execute(input: GetArticleInput): Promise<Article> {
    const course = await this.courses.findById(input.courseId);
    if (course === null) throw new CourseNotFound();
    const lecture = await this.curriculum.findLecture(course.id, input.lectureId);
    if (lecture === null) throw new LectureNotFound();
    assertArticleLecture(lecture.type);
    return toArticleView(lecture.id, await this.curriculum.findArticle(lecture.id));
  }
}
