import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { QuestionNotFound } from '../../domain/engagement.errors';
import type { ReportableSubject, ReportFilingContext } from '../../domain/report';
import { ModerationEvents } from '../moderation-events';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { QaAccess } from '../qa-access';
import { ReportSubjectHandler } from './report-subject.handler';

/**
 * Questions are reportable by whoever can read the course's Q&A (an active learner or the
 * owner, from either app) while they are VISIBLE and not deleted. An automatic hide emits
 * `QuestionHidden` (actor null) and, after the commit, the `qa.changed` hint.
 */
@Injectable()
export class QuestionReportSubject extends ReportSubjectHandler {
  readonly type = 'QUESTION' as const;

  constructor(
    private readonly qa: QaRepository,
    private readonly access: QaAccess,
    private readonly moderation: ModerationEvents,
    private readonly hints: QaHints,
  ) {
    super();
  }

  async resolve(routeId: string, reporterId: string): Promise<ReportableSubject> {
    const question = await this.qa.findQuestion(routeId);
    if (
      question === null ||
      question.deletedAt !== null ||
      question.moderationStatus !== 'VISIBLE' ||
      (await this.access.visibleTo(question.courseId, reporterId)) === null
    ) {
      throw new QuestionNotFound();
    }
    return {
      type: this.type,
      routeId,
      subjectId: question.id,
      courseId: question.courseId,
      authorId: question.authorId,
      reviewId: null,
      questionId: question.id,
      lectureId: question.lectureId,
    };
  }

  notFound(): Error {
    return new QuestionNotFound();
  }

  publishAutoHidden(
    trx: Transaction<DB>,
    subject: ReportableSubject,
    hiddenAt: Date,
    context: ReportFilingContext,
  ): Promise<void> {
    return this.moderation.hidden(trx, subject, null, hiddenAt, context);
  }

  override afterAutoHideCommitted(subject: ReportableSubject): Promise<void> {
    return this.hints.changed({
      courseId: subject.courseId,
      questionId: subject.subjectId,
      lectureId: subject.lectureId,
    });
  }
}
