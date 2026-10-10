import type { CourseCreatedPayload, CourseDeletedPayload } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * `catalog.course` integration events, written in the caller's transaction (outbox; topic =
 * aggregateType, key = courseId). P2-T10 adds the submit/decision/archive events here.
 */
export abstract class CatalogEventPublisher {
  abstract courseCreated(trx: Transaction<DB>, payload: CourseCreatedPayload): Promise<void>;
  abstract courseDeleted(trx: Transaction<DB>, payload: CourseDeletedPayload): Promise<void>;
}
