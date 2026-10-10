import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

/**
 * Course titles for the decision and takedown mails, whose events carry ids only. Read in the
 * handler's transaction; null when the course row is gone.
 */
@Injectable()
export class CourseTitleReader {
  /** The title of the reviewed revision (what the admin decided on), else the working copy's. */
  async ofRevision(
    trx: Transaction<DB>,
    courseId: string,
    revisionId: string,
  ): Promise<string | null> {
    const row = await trx
      .selectFrom('catalog.courses as c')
      .leftJoin('catalog.courseRevisions as r', (join) =>
        join.onRef('r.courseId', '=', 'c.id').on('r.id', '=', revisionId),
      )
      .select(['c.title as courseTitle', 'r.title as revisionTitle'])
      .where('c.id', '=', courseId)
      .executeTakeFirst();
    return row === undefined ? null : (row.revisionTitle ?? row.courseTitle);
  }

  /** The title of the live (published) revision, else the working copy's. */
  async live(trx: Transaction<DB>, courseId: string): Promise<string | null> {
    const row = await trx
      .selectFrom('catalog.courses as c')
      .leftJoin('catalog.courseRevisions as r', 'r.id', 'c.publishedRevisionId')
      .select(['c.title as courseTitle', 'r.title as revisionTitle'])
      .where('c.id', '=', courseId)
      .executeTakeFirst();
    return row === undefined ? null : (row.revisionTitle ?? row.courseTitle);
  }
}
