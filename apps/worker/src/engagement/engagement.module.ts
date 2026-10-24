import { Module } from '@nestjs/common';
import {
  RatingOnReviewDeleted,
  RatingOnReviewEdited,
  RatingOnReviewHidden,
  RatingOnReviewPosted,
  RatingOnReviewRestored,
} from './handlers/rating-aggregator.handlers';
import {
  ReviewReinstateOnRegrantHandler,
  ReviewSuspendOnRevokeHandler,
} from './handlers/review-enrollment-sync.handlers';
import { ReviewSuspension } from './persistence/review-suspension';

/**
 * Worker side of engagement (Phase 5 design D9, D11, P5-T15): the rating aggregator (review
 * events -> `course_rating_stats` recompute) and the review-enrollment sync (suspend / reinstate
 * reviews with the enrollment). Uses the global DatabaseModule. Nothing is exported.
 */
@Module({
  providers: [
    ReviewSuspension,
    RatingOnReviewPosted,
    RatingOnReviewEdited,
    RatingOnReviewDeleted,
    RatingOnReviewHidden,
    RatingOnReviewRestored,
    ReviewSuspendOnRevokeHandler,
    ReviewReinstateOnRegrantHandler,
  ],
})
export class EngagementModule {}
