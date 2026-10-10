import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { assertWorkingCopyEditable } from '../domain/course';
import { CourseNotFound } from '../domain/catalog.errors';
import { type CourseRecord, CourseRepository } from './ports/course.repository';

/**
 * The per-course row lock every course write starts with (design §5: `SELECT ... FOR NO KEY
 * UPDATE` on the non-deleted course). Lock order everywhere: course -> category (FOR SHARE) ->
 * media assets ascending (taken inside MediaFacade).
 *
 * P2-T10's lifecycle use cases use `lock` (they decide the state rules themselves); every
 * working-copy write uses `lockEditable`.
 */
@Injectable()
export class CourseLocker {
  constructor(private readonly courses: CourseRepository) {}

  /** @throws CourseNotFound (404) for a missing or deleted course */
  async lock(trx: Transaction<DB>, courseId: string): Promise<CourseRecord> {
    const course = await this.courses.lockForUpdate(trx, courseId);
    if (course === null) throw new CourseNotFound();
    return course;
  }

  /**
   * Locks the course for a working-copy write by its owner. The route policy already proved
   * ownership; checking it again here keeps a misconfigured route from becoming an IDOR (a
   * foreign course is "not found", never 403).
   *
   * @throws CourseNotFound (404), CourseInReview (409), CourseNotEditable (409)
   */
  async lockEditable(
    trx: Transaction<DB>,
    courseId: string,
    actorId: string,
  ): Promise<CourseRecord> {
    const course = await this.lock(trx, courseId);
    if (course.ownerId !== actorId) throw new CourseNotFound();
    assertWorkingCopyEditable(course);
    return course;
  }
}
