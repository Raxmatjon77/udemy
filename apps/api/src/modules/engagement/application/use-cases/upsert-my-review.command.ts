import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type MyReview,
  ReviewEdited,
  ReviewPosted,
  type ReviewBlockReason,
} from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import {
  CannotReviewOwnCourse,
  CourseNotFound,
  EnrollmentRequired,
  ReviewNotEligible,
} from '../../domain/engagement.errors';
import { PeopleDirectory } from '../people';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { ReviewRepository } from '../ports/review.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { ReviewEligibility } from '../review-eligibility';
import { reviewAuthorIds, toMyReview } from '../review-views';

export interface UpsertMyReviewInput {
  readonly userId: string;
  readonly courseId: string;
  readonly rating: number;
  /** Trimmed plain text (the request schema), or null for a rating without text. */
  readonly body: string | null;
}

export interface UpsertMyReviewResult {
  readonly review: MyReview;
  /** True for a new review (201); false for an edit or an unchanged repeat (200). */
  readonly created: boolean;
}

function blockError(reason: ReviewBlockReason): Error {
  switch (reason) {
    case ErrorCode.CannotReviewOwnCourse:
      return new CannotReviewOwnCourse();
    case ErrorCode.EnrollmentRequired:
      return new EnrollmentRequired();
    case ErrorCode.ReviewNotEligible:
      return new ReviewNotEligible();
  }
}

/**
 * `UpsertMyReview` (design §5, D10, R4): one live review per (course, user). Eligibility (not
 * the owner, an ACTIVE enrollment, >= 1 completed lecture) is checked first; then the
 * `@udemy/db` upsert decides POSTED (201, `ReviewPosted`), EDITED (200, `ReviewEdited` with
 * `previousRating`) or UNCHANGED (200, no event). Edits are allowed in any state (the author
 * may fix a hidden review); the aggregate only counts PUBLISHED reviews.
 *
 * Errors: 404 `course_not_found`, 403 `enrollment_required` / `cannot_review_own_course`,
 * 422 `review_not_eligible`, 429 (20 per 24 h).
 */
@Injectable()
export class UpsertMyReviewCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly catalog: CatalogFacade,
    private readonly eligibility: ReviewEligibility,
    private readonly reviews: ReviewRepository,
    private readonly events: EngagementEventPublisher,
    private readonly people: PeopleDirectory,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: UpsertMyReviewInput): Promise<UpsertMyReviewResult> {
    await this.rateLimiter.hit('reviewWrite', input.userId);
    const course = await this.catalog.getPublishedCourse(input.courseId);
    if (course === null) throw new CourseNotFound();
    const block = await this.eligibility.blockReason(input.userId, course);
    if (block !== null) throw blockError(block);

    const { outcome, review } = await this.tx.run(async (trx) => {
      const result = await this.reviews.upsert(trx, {
        courseId: course.id,
        userId: input.userId,
        rating: input.rating,
        body: input.body,
      });
      const r = result.review;
      if (result.outcome === 'POSTED') {
        await this.events.publish(trx, ReviewPosted, {
          reviewId: r.id,
          courseId: r.courseId,
          userId: r.userId,
          rating: r.rating,
          previousRating: null,
          postedAt: r.createdAt.toISOString(),
        });
      } else if (result.outcome === 'EDITED') {
        if (result.previousRating === null || r.editedAt === null) {
          throw new Error(`edited review ${r.id} has no previous rating or edit time`);
        }
        await this.events.publish(trx, ReviewEdited, {
          reviewId: r.id,
          courseId: r.courseId,
          userId: r.userId,
          rating: r.rating,
          previousRating: result.previousRating,
          editedAt: r.editedAt.toISOString(),
        });
      }
      return result;
    });
    const people = await this.people.lookup(reviewAuthorIds([review]));
    return { review: toMyReview(review, people), created: outcome === 'POSTED' };
  }
}
