import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

export interface CertificateSource {
  /** Snapshot texts of the certificate (design D7): what it says, as of issue. */
  readonly recipientName: string;
  readonly courseTitle: string;
  readonly instructorName: string;
  /** The live revision at issue (title source); the completed revision when none is live. */
  readonly revisionId: string;
  /** The learner's enrollment right now (null: none). */
  readonly enrollmentStatus: 'ACTIVE' | 'REVOKED' | null;
}

/**
 * Reads what the certificate issuer snapshots (the `CourseCompleted` event carries ids only):
 * the recipient's display name, the live revision's title and the course owner's display name.
 * Read in the handler's transaction after the `lrnc` lock, so the enrollment status is fresh.
 * null when the learner or the course is gone.
 */
@Injectable()
export class CertificateSourceReader {
  async find(
    trx: Transaction<DB>,
    input: { userId: string; courseId: string; completedRevisionId: string },
  ): Promise<CertificateSource | null> {
    const course = await trx
      .selectFrom('catalog.courses as c')
      .innerJoin('identity.users as o', 'o.id', 'c.ownerId')
      .leftJoin('catalog.courseRevisions as r', 'r.id', 'c.publishedRevisionId')
      .select([
        'c.title as courseTitle',
        'c.publishedRevisionId',
        'r.title as revisionTitle',
        'o.displayName as instructorName',
      ])
      .where('c.id', '=', input.courseId)
      .executeTakeFirst();
    const learner = await trx
      .selectFrom('identity.users')
      .select('displayName')
      .where('id', '=', input.userId)
      .executeTakeFirst();
    if (course === undefined || learner === undefined) return null;
    const enrollment = await trx
      .selectFrom('enrollment.enrollments')
      .select('status')
      .where('userId', '=', input.userId)
      .where('courseId', '=', input.courseId)
      .executeTakeFirst();
    return {
      recipientName: learner.displayName,
      courseTitle: course.revisionTitle ?? course.courseTitle,
      instructorName: course.instructorName,
      revisionId: course.publishedRevisionId ?? input.completedRevisionId,
      enrollmentStatus:
        enrollment === undefined ? null : enrollment.status === 'ACTIVE' ? 'ACTIVE' : 'REVOKED',
    };
  }
}
