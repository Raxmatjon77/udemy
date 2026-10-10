import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

export interface EnrolledCourse {
  readonly ownerId: string;
  /** The live (published) revision's title, else the working copy's. */
  readonly title: string;
}

/**
 * The instructor (course owner) and title of an enrolled course, for the new-enrollment mail
 * (`EnrollmentGranted` carries ids only). Read in the handler's transaction; null when the
 * course row is gone.
 */
@Injectable()
export class EnrolledCourseReader {
  async find(trx: Transaction<DB>, courseId: string): Promise<EnrolledCourse | null> {
    const row = await trx
      .selectFrom('catalog.courses as c')
      .leftJoin('catalog.courseRevisions as r', 'r.id', 'c.publishedRevisionId')
      .select(['c.ownerId', 'c.title as courseTitle', 'r.title as revisionTitle'])
      .where('c.id', '=', courseId)
      .executeTakeFirst();
    return row === undefined
      ? null
      : { ownerId: row.ownerId, title: row.revisionTitle ?? row.courseTitle };
  }
}
