import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { CourseNotFound } from '../../domain/catalog.errors';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseRepository } from '../ports/course.repository';

/**
 * `GetCourse` (design §5): the working copy for its owner or an admin (the route policy
 * decides who; `course:read:any` skips the ownership lookup, so a missing or deleted course is
 * answered here with 404 `course_not_found`). Includes readiness for the builder's checklist.
 */
@Injectable()
export class GetCourseQuery {
  constructor(
    private readonly courses: CourseRepository,
    private readonly detail: CourseDetailAssembler,
  ) {}

  async execute(courseId: string): Promise<CourseDetail> {
    const course = await this.courses.findById(courseId);
    if (course === null) throw new CourseNotFound();
    return this.detail.build(course);
  }
}
