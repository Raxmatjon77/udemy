import { Injectable } from '@nestjs/common';
import { type ReviewReply, ReviewReplyEdited, ReviewReplyPosted } from '@udemy/contracts';
import { ReviewNotFound } from '../../domain/engagement.errors';
import { isRepliable } from '../../domain/review';
import { PeopleDirectory } from '../people';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { ReviewRepository } from '../ports/review.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toReviewReply } from '../review-views';

export interface UpsertReviewReplyInput {
  /** The course owner (`@CheckPolicy({ resource: 'course', action: 'engage' })`). */
  readonly actorId: string;
  readonly courseId: string;
  readonly reviewId: string;
  readonly body: string;
}

/**
 * `UpsertReviewReply` (design §5, D10): one live reply per review, by the course owner. The
 * review is resolved WITHIN the course (a foreign review id is 404, IDOR) and must be PUBLISHED
 * or HIDDEN (not suspended). The review row is share-locked for the transaction so a
 * concurrent delete or suspension cannot slip in between the check and the write.
 * POSTED -> `ReviewReplyPosted`, EDITED -> `ReviewReplyEdited`, UNCHANGED -> no event; 200.
 *
 * Errors: 404 `review_not_found`, 429 (100 per 24 h).
 */
@Injectable()
export class UpsertReviewReplyCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly reviews: ReviewRepository,
    private readonly events: EngagementEventPublisher,
    private readonly people: PeopleDirectory,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: UpsertReviewReplyInput): Promise<ReviewReply> {
    await this.rateLimiter.hit('reviewReply', input.actorId);
    const review = await this.tx.run(async (trx) => {
      const locked = await this.reviews.lockLiveInCourse(trx, input.courseId, input.reviewId);
      if (locked === null || !isRepliable(locked)) throw new ReviewNotFound();
      const { outcome, review: after } = await this.reviews.upsertReply(trx, {
        reviewId: locked.id,
        authorId: input.actorId,
        body: input.body,
      });
      const reply = after.reply;
      if (reply === null) throw new Error(`reply of review ${after.id} vanished after the upsert`);
      const fields = { reviewId: after.id, courseId: after.courseId, authorId: reply.authorId };
      if (outcome === 'POSTED') {
        await this.events.publish(trx, ReviewReplyPosted, {
          ...fields,
          postedAt: reply.createdAt.toISOString(),
        });
      } else if (outcome === 'EDITED') {
        if (reply.editedAt === null) throw new Error(`edited reply ${reply.id} has no edit time`);
        await this.events.publish(trx, ReviewReplyEdited, {
          ...fields,
          editedAt: reply.editedAt.toISOString(),
        });
      }
      return after;
    });
    const reply = review.reply;
    if (reply === null) throw new Error(`reply of review ${review.id} vanished`);
    const people = await this.people.lookup([reply.authorId]);
    return toReviewReply(review.id, reply, people);
  }
}
