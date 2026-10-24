import { Logger } from '@nestjs/common';
import {
  ENGAGEMENT_COURSE_REVIEW_AGGREGATE,
  type EventDefinition,
  type EventEnvelope,
  ReviewDeleted,
  ReviewEdited,
  ReviewHidden,
  ReviewPosted,
  ReviewRestored,
} from '@udemy/contracts';
import { type DB, recomputeCourseRating, type Transaction } from '@udemy/db';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';

/*
 * `engagement.rating-aggregator` (design D11, schema doc §8.4, R11): every review event that can
 * change the PUBLISHED set recomputes the WHOLE `course_rating_stats` row of the course from
 * `engagement.reviews` under the stats row lock (`recomputeCourseRating`). Recompute is
 * idempotent, order-independent and self-healing, so a redelivery or an out-of-order event can
 * never drift the histogram. The topic is keyed by courseId (one partition per course).
 * One handler per event type: `engagement.rating-aggregator.<event>`.
 */

type ReviewEventDefinition =
  | typeof ReviewPosted
  | typeof ReviewEdited
  | typeof ReviewDeleted
  | typeof ReviewHidden
  | typeof ReviewRestored;

abstract class RatingRecomputeHandler implements EventHandlerContract {
  protected abstract readonly definition: ReviewEventDefinition;
  private readonly logger = new Logger('RatingAggregator');

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(this.definition as EventDefinition, envelope) as { courseId: string };
    const rating = await recomputeCourseRating(trx, event.courseId);
    this.logger.debug(
      { courseId: rating.courseId, reviewCount: rating.reviewCount, average: rating.average },
      'Course rating recomputed',
    );
  }
}

@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewPosted.type, {
  consumerName: 'engagement.rating-aggregator.review-posted',
})
export class RatingOnReviewPosted extends RatingRecomputeHandler {
  protected readonly definition = ReviewPosted;
}

@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewEdited.type, {
  consumerName: 'engagement.rating-aggregator.review-edited',
})
export class RatingOnReviewEdited extends RatingRecomputeHandler {
  protected readonly definition = ReviewEdited;
}

@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewDeleted.type, {
  consumerName: 'engagement.rating-aggregator.review-deleted',
})
export class RatingOnReviewDeleted extends RatingRecomputeHandler {
  protected readonly definition = ReviewDeleted;
}

@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewHidden.type, {
  consumerName: 'engagement.rating-aggregator.review-hidden',
})
export class RatingOnReviewHidden extends RatingRecomputeHandler {
  protected readonly definition = ReviewHidden;
}

@EventHandler(ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ReviewRestored.type, {
  consumerName: 'engagement.rating-aggregator.review-restored',
})
export class RatingOnReviewRestored extends RatingRecomputeHandler {
  protected readonly definition = ReviewRestored;
}
