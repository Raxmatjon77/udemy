import { Injectable } from '@nestjs/common';
import {
  CourseArchived,
  type CourseArchivedPayload,
  CourseCreated,
  type CourseCreatedPayload,
  CourseDeleted,
  type CourseDeletedPayload,
  CoursePublished,
  type CoursePublishedPayload,
  CourseRejected,
  type CourseRejectedPayload,
  CourseRestored,
  type CourseRestoredPayload,
  CourseSubmissionWithdrawn,
  type CourseSubmissionWithdrawnPayload,
  CourseSubmittedForReview,
  type CourseSubmittedForReviewPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { CatalogEventPublisher } from '../application/ports/catalog-event.publisher';

/** `catalog.course` events through the transactional outbox; key = courseId. */
@Injectable()
export class OutboxCatalogEventPublisher extends CatalogEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async courseCreated(trx: Transaction<DB>, payload: CourseCreatedPayload): Promise<void> {
    await this.outbox.publish(trx, CourseCreated, payload.courseId, payload);
  }

  async courseDeleted(trx: Transaction<DB>, payload: CourseDeletedPayload): Promise<void> {
    await this.outbox.publish(trx, CourseDeleted, payload.courseId, payload);
  }

  async courseSubmittedForReview(
    trx: Transaction<DB>,
    payload: CourseSubmittedForReviewPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, CourseSubmittedForReview, payload.courseId, payload);
  }

  async courseSubmissionWithdrawn(
    trx: Transaction<DB>,
    payload: CourseSubmissionWithdrawnPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, CourseSubmissionWithdrawn, payload.courseId, payload);
  }

  async coursePublished(trx: Transaction<DB>, payload: CoursePublishedPayload): Promise<void> {
    await this.outbox.publish(trx, CoursePublished, payload.courseId, payload);
  }

  async courseRejected(trx: Transaction<DB>, payload: CourseRejectedPayload): Promise<void> {
    await this.outbox.publish(trx, CourseRejected, payload.courseId, payload);
  }

  async courseArchived(trx: Transaction<DB>, payload: CourseArchivedPayload): Promise<void> {
    await this.outbox.publish(trx, CourseArchived, payload.courseId, payload);
  }

  async courseRestored(trx: Transaction<DB>, payload: CourseRestoredPayload): Promise<void> {
    await this.outbox.publish(trx, CourseRestored, payload.courseId, payload);
  }
}
