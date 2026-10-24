import type { DB, Transaction } from '@udemy/db';
import type { AnnouncementRecord } from '../../domain/announcement';
import type { CreatedAtKeyset, CreatedAtRow } from './qa.repository';

/** `engagement.announcements` (D18): immutable rows, one soft delete. */
export abstract class AnnouncementRepository {
  /** Non-deleted announcements of the course, newest first (keyset created_at DESC, id DESC). */
  abstract listLive(
    courseId: string,
    after: CreatedAtKeyset | null,
    limit: number,
  ): Promise<CreatedAtRow<AnnouncementRecord>[]>;

  /**
   * Creation times of the course's announcements inside the quota window (deleted ones
   * included: deleting does not refund quota). Pass `trx` after `lockQuota` for exact numbers.
   */
  abstract windowCreatedAts(courseId: string, trx?: Transaction<DB>): Promise<Date[]>;

  /**
   * Takes the course's `anno` advisory lock (R12) for the transaction and returns the number
   * of announcements in the window (`@udemy/db` `lockAnnouncementQuota`).
   */
  abstract lockQuota(trx: Transaction<DB>, courseId: string): Promise<number>;

  abstract insert(
    trx: Transaction<DB>,
    input: {
      courseId: string;
      authorId: string;
      title: string;
      bodyMd: string;
      sendEmail: boolean;
    },
  ): Promise<AnnouncementRecord>;

  /** Soft delete of an announcement of THIS course; null when unknown or already deleted. */
  abstract softDelete(
    trx: Transaction<DB>,
    courseId: string,
    announcementId: string,
    actorId: string,
  ): Promise<{ readonly announcement: AnnouncementRecord; readonly deletedAt: Date } | null>;
}
