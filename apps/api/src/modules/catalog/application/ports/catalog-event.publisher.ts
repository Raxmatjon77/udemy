import type {
  CourseArchivedPayload,
  CourseCreatedPayload,
  CourseDeletedPayload,
  CoursePublishedPayload,
  CourseRejectedPayload,
  CourseRestoredPayload,
  CourseSubmissionWithdrawnPayload,
  CourseSubmittedForReviewPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * `catalog.course` integration events (design §7), written in the caller's transaction
 * (outbox; topic = aggregateType, key = courseId, so events are ordered per course).
 */
export abstract class CatalogEventPublisher {
  abstract courseCreated(trx: Transaction<DB>, payload: CourseCreatedPayload): Promise<void>;
  abstract courseDeleted(trx: Transaction<DB>, payload: CourseDeletedPayload): Promise<void>;
  abstract courseSubmittedForReview(
    trx: Transaction<DB>,
    payload: CourseSubmittedForReviewPayload,
  ): Promise<void>;
  abstract courseSubmissionWithdrawn(
    trx: Transaction<DB>,
    payload: CourseSubmissionWithdrawnPayload,
  ): Promise<void>;
  abstract coursePublished(trx: Transaction<DB>, payload: CoursePublishedPayload): Promise<void>;
  abstract courseRejected(trx: Transaction<DB>, payload: CourseRejectedPayload): Promise<void>;
  abstract courseArchived(trx: Transaction<DB>, payload: CourseArchivedPayload): Promise<void>;
  abstract courseRestored(trx: Transaction<DB>, payload: CourseRestoredPayload): Promise<void>;
}
