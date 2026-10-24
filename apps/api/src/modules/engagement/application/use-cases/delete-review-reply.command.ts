import { Injectable } from '@nestjs/common';
import { ReviewReplyDeleted } from '@udemy/contracts';
import { ReplyNotFound, ReviewNotFound } from '../../domain/engagement.errors';
import { isRepliable } from '../../domain/review';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { ReviewRepository } from '../ports/review.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/**
 * `DeleteReviewReply` (design §5): soft delete of the live reply of a review in the owner's
 * course, with `ReviewReplyDeleted` (the reply keeps its reports and moderation history; a new
 * reply gets a new id). Errors: 404 `review_not_found` (unknown, foreign, deleted or suspended
 * review), 404 `reply_not_found` (no live reply).
 */
@Injectable()
export class DeleteReviewReplyCommand {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: { actorId: string; courseId: string; reviewId: string }): Promise<void> {
    await this.tx.run(async (trx) => {
      const review = await this.reviews.lockLiveInCourse(trx, input.courseId, input.reviewId);
      if (review === null || !isRepliable(review)) throw new ReviewNotFound();
      const deleted = await this.reviews.softDeleteReply(trx, review.id);
      if (deleted === null) throw new ReplyNotFound();
      await this.events.publish(trx, ReviewReplyDeleted, {
        reviewId: review.id,
        courseId: review.courseId,
        authorId: deleted.authorId,
        deletedAt: deleted.deletedAt.toISOString(),
      });
    });
  }
}
