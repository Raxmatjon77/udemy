import type { DB, Executor, Transaction } from '@udemy/db';
import type { CourseRatingStats, ReviewRecord } from '../../domain/review';

/** Keyset of the review lists: `created_at` exactly as SQL printed it, then the review id. */
export interface ReviewKeyset {
  readonly createdAt: string;
  readonly id: string;
}

export interface ReviewListRow {
  readonly review: ReviewRecord;
  /** `created_at` as exact UTC text (microseconds) for the next cursor. */
  readonly createdAtKey: string;
}

export interface ReviewListFilter {
  readonly courseId: string;
  readonly rating?: number | undefined;
  readonly after: ReviewKeyset | null;
  readonly limit: number;
}

export type UpsertOutcome = 'POSTED' | 'EDITED' | 'UNCHANGED';

export interface UpsertReviewRecord {
  readonly outcome: UpsertOutcome;
  /** EDITED: the rating before the edit; otherwise null. */
  readonly previousRating: number | null;
  /** The row after the write, re-read in the same transaction. */
  readonly review: ReviewRecord;
}

export interface UpsertReplyRecord {
  readonly outcome: UpsertOutcome;
  /** The review (and its reply) after the write, re-read in the same transaction. */
  readonly review: ReviewRecord;
}

export interface SoftDeleted {
  readonly id: string;
  readonly deletedAt: Date;
}

export interface SoftDeletedReply extends SoftDeleted {
  readonly authorId: string;
}

/**
 * `engagement.reviews` / `review_replies` / `course_rating_stats` (D10, D11). Writes take the
 * caller's transaction; timestamps always come from SQL `now()`.
 */
export abstract class ReviewRepository {
  /** The read model rows of the given courses (absent = no reviews yet). */
  abstract getRatings(courseIds: readonly string[]): Promise<CourseRatingStats[]>;

  /** PUBLISHED reviews (VISIBLE, not suspended, not deleted), newest first. */
  abstract listPublished(filter: ReviewListFilter): Promise<ReviewListRow[]>;

  /** Every non-deleted review (hidden and suspended included), newest first. */
  abstract listLive(filter: ReviewListFilter): Promise<ReviewListRow[]>;

  /** The user's live (non-deleted) review of the course. */
  abstract findLiveByUser(
    courseId: string,
    userId: string,
    ex?: Executor,
  ): Promise<ReviewRecord | null>;

  /** A live review by id (any course). */
  abstract findLiveById(reviewId: string, ex?: Executor): Promise<ReviewRecord | null>;

  /** One live review per (course, user): the `@udemy/db` upsert (R4). */
  abstract upsert(
    trx: Transaction<DB>,
    input: { courseId: string; userId: string; rating: number; body: string | null },
  ): Promise<UpsertReviewRecord>;

  /** Soft delete of the user's live review (`deleted_by` = the user); null when none. */
  abstract softDeleteByUser(
    trx: Transaction<DB>,
    courseId: string,
    userId: string,
  ): Promise<SoftDeleted | null>;

  /**
   * Locks (`FOR SHARE`) a live review of THIS course for a reply write, so a concurrent delete
   * or suspension waits for the reply transaction. Null when unknown, deleted or in another
   * course.
   */
  abstract lockLiveInCourse(
    trx: Transaction<DB>,
    courseId: string,
    reviewId: string,
  ): Promise<ReviewRecord | null>;

  /** One live reply per review: the `@udemy/db` upsert. The author is the course owner. */
  abstract upsertReply(
    trx: Transaction<DB>,
    input: { reviewId: string; authorId: string; body: string },
  ): Promise<UpsertReplyRecord>;

  /** Soft delete of the review's live reply; null when it has none. */
  abstract softDeleteReply(
    trx: Transaction<DB>,
    reviewId: string,
  ): Promise<SoftDeletedReply | null>;
}
