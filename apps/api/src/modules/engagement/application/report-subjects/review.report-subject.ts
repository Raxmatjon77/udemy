import { Injectable } from '@nestjs/common';
import { ReviewHidden } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { ReviewNotFound } from '../../domain/engagement.errors';
import type { ReportableSubject } from '../../domain/report';
import { isPublished } from '../../domain/review';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { ReviewRepository } from '../ports/review.repository';
import { ReportSubjectHandler } from './report-subject.handler';

/** Reviews are public: anyone may report a PUBLISHED review (not their own). */
@Injectable()
export class ReviewReportSubject extends ReportSubjectHandler {
  readonly type = 'REVIEW' as const;

  constructor(
    private readonly reviews: ReviewRepository,
    private readonly events: EngagementEventPublisher,
  ) {
    super();
  }

  async resolve(routeId: string): Promise<ReportableSubject> {
    const review = await this.reviews.findLiveById(routeId);
    if (review === null || !isPublished(review)) throw new ReviewNotFound();
    return {
      type: this.type,
      routeId,
      subjectId: review.id,
      courseId: review.courseId,
      authorId: review.userId,
      reviewId: review.id,
    };
  }

  notFound(): Error {
    return new ReviewNotFound();
  }

  async publishAutoHidden(
    trx: Transaction<DB>,
    subject: ReportableSubject,
    hiddenAt: Date,
  ): Promise<void> {
    await this.events.publish(trx, ReviewHidden, {
      reviewId: subject.subjectId,
      courseId: subject.courseId,
      actorId: null,
      hiddenAt: hiddenAt.toISOString(),
    });
  }
}
