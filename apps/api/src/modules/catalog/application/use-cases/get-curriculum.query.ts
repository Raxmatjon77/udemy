import { Injectable } from '@nestjs/common';
import type { Curriculum } from '@udemy/contracts';
import { CourseNotFound } from '../../domain/catalog.errors';
import { CurriculumReader } from '../curriculum-reader';
import { CourseRepository } from '../ports/course.repository';
import { toCurriculumView } from '../views';

/**
 * `GetCurriculum` (design §5): sections and lectures in order, with per-asset status,
 * progress and duration from ONE `MediaFacade.getAssets` call. Owner or admin (route policy).
 */
@Injectable()
export class GetCurriculumQuery {
  constructor(
    private readonly courses: CourseRepository,
    private readonly reader: CurriculumReader,
  ) {}

  async execute(courseId: string): Promise<Curriculum> {
    const course = await this.courses.findById(courseId);
    if (course === null) throw new CourseNotFound();
    return toCurriculumView(course, await this.reader.load(course));
  }
}
