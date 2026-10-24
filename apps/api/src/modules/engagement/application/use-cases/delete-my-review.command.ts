import { Injectable } from '@nestjs/common';
import { ReviewDeleted } from '@udemy/contracts';
import { ReviewNotFound } from '../../domain/engagement.errors';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { ReviewRepository } from '../ports/review.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/**
 * `DeleteMyReview` (design §5): soft delete of the caller's live review in any state, with
 * `ReviewDeleted` (the aggregate drops it). A new review may follow. No live review: 404
 * `review_not_found` (contracts), so a repeated DELETE is 404, never a second event.
 */
@Injectable()
export class DeleteMyReviewCommand {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: { userId: string; courseId: string }): Promise<void> {
    await this.tx.run(async (trx) => {
      const deleted = await this.reviews.softDeleteByUser(trx, input.courseId, input.userId);
      if (deleted === null) throw new ReviewNotFound();
      await this.events.publish(trx, ReviewDeleted, {
        reviewId: deleted.id,
        courseId: input.courseId,
        actorId: input.userId,
        deletedAt: deleted.deletedAt.toISOString(),
      });
    });
  }
}
