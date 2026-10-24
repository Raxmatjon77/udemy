import { Logger } from '@nestjs/common';
import {
  ENROLLMENT_ENROLLMENT_AGGREGATE,
  EnrollmentGranted,
  EnrollmentRevoked,
  type EventEnvelope,
} from '@udemy/contracts';
import { type DB, recomputeCourseRating, type Transaction } from '@udemy/db';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { ReviewSuspension } from '../persistence/review-suspension';

/*
 * `engagement.review-enrollment-sync` (design D9, §5 worker table, R11): a revoked enrollment
 * suspends the learner's review of that course (hidden, out of the aggregate); a regrant
 * reinstates it. Then the course rating is recomputed with the shared `recomputeCourseRating`
 * (stats row lock; the rating aggregator on the review topic serialises on the same row).
 * Lock order: review row -> stats row. Consumer names `engagement.review-enrollment-sync.<event>`.
 */

@EventHandler(ENROLLMENT_ENROLLMENT_AGGREGATE, EnrollmentRevoked.type, {
  consumerName: 'engagement.review-enrollment-sync.enrollment-revoked',
})
export class ReviewSuspendOnRevokeHandler implements EventHandlerContract {
  private readonly logger = new Logger(ReviewSuspendOnRevokeHandler.name);

  constructor(private readonly reviews: ReviewSuspension) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(EnrollmentRevoked, envelope);
    const reviewId = await this.reviews.suspend(trx, event.userId, event.courseId);
    if (reviewId === null) return;
    await recomputeCourseRating(trx, event.courseId);
    this.logger.log({ reviewId, courseId: event.courseId }, 'Review suspended with the enrollment');
  }
}

@EventHandler(ENROLLMENT_ENROLLMENT_AGGREGATE, EnrollmentGranted.type, {
  consumerName: 'engagement.review-enrollment-sync.enrollment-granted',
})
export class ReviewReinstateOnRegrantHandler implements EventHandlerContract {
  private readonly logger = new Logger(ReviewReinstateOnRegrantHandler.name);

  constructor(private readonly reviews: ReviewSuspension) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(EnrollmentGranted, envelope);
    if (!event.regrant) return;
    const reviewId = await this.reviews.reinstate(trx, event.userId, event.courseId);
    if (reviewId === null) return;
    await recomputeCourseRating(trx, event.courseId);
    this.logger.log({ reviewId, courseId: event.courseId }, 'Review reinstated with the regrant');
  }
}
