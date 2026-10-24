import { Injectable } from '@nestjs/common';
import { ReviewReplyHidden } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { ReplyNotFound } from '../../domain/engagement.errors';
import type { ReportableSubject } from '../../domain/report';
import { isPublished, publicReplyOf } from '../../domain/review';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { ReviewRepository } from '../ports/review.repository';
import { ReportSubjectHandler } from './report-subject.handler';

/**
 * Replies are addressed by their REVIEW id (contracts `REPORT_SUBJECT_PATHS`: one live reply
 * per review). Reportable when it is publicly shown: the review is PUBLISHED and the live reply
 * VISIBLE. The report references the reply row itself, so a later new reply starts clean.
 */
@Injectable()
export class ReviewReplyReportSubject extends ReportSubjectHandler {
  readonly type = 'REVIEW_REPLY' as const;

  constructor(
    private readonly reviews: ReviewRepository,
    private readonly events: EngagementEventPublisher,
  ) {
    super();
  }

  async resolve(routeId: string): Promise<ReportableSubject> {
    const review = await this.reviews.findLiveById(routeId);
    const reply = review === null || !isPublished(review) ? null : publicReplyOf(review);
    if (review === null || reply === null) throw new ReplyNotFound();
    return {
      type: this.type,
      routeId,
      subjectId: reply.id,
      courseId: review.courseId,
      authorId: reply.authorId,
      reviewId: review.id,
    };
  }

  notFound(): Error {
    return new ReplyNotFound();
  }

  async publishAutoHidden(
    trx: Transaction<DB>,
    subject: ReportableSubject,
    hiddenAt: Date,
  ): Promise<void> {
    if (subject.reviewId === null) throw new Error('a reply subject always carries its review id');
    await this.events.publish(trx, ReviewReplyHidden, {
      reviewId: subject.reviewId,
      courseId: subject.courseId,
      authorId: subject.authorId,
      actorId: null,
      hiddenAt: hiddenAt.toISOString(),
    });
  }
}
