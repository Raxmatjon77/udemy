import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import { AnswerNotFound } from '../../domain/engagement.errors';
import { canSeeQuestion } from '../../domain/qa';
import {
  NO_FILING_CONTEXT,
  type ReportableSubject,
  type ReportFilingContext,
} from '../../domain/report';
import { ModerationEvents } from '../moderation-events';
import { QaRepository } from '../ports/qa.repository';
import { QaHints } from '../ports/qa-hints';
import { QaAccess } from '../qa-access';
import { ReportSubjectHandler } from './report-subject.handler';

/**
 * Answers are reportable while VISIBLE and not deleted, under a question the reporter can see,
 * by an active learner or the owner. Before filing, the answer and then its question are
 * locked (the order of `@udemy/db` and the counter trigger) to learn whether it is the accepted
 * answer: an automatic hide clears it (DB trigger), so `AnswerHidden` is followed by
 * `QuestionReopened`.
 */
@Injectable()
export class AnswerReportSubject extends ReportSubjectHandler {
  readonly type = 'ANSWER' as const;

  constructor(
    private readonly qa: QaRepository,
    private readonly access: QaAccess,
    private readonly moderation: ModerationEvents,
    private readonly hints: QaHints,
  ) {
    super();
  }

  async resolve(routeId: string, reporterId: string): Promise<ReportableSubject> {
    const found = await this.qa.findAnswer(routeId);
    if (
      found === null ||
      found.answer.deletedAt !== null ||
      found.answer.moderationStatus !== 'VISIBLE' ||
      !canSeeQuestion(found.question, reporterId) ||
      (await this.access.visibleTo(found.question.courseId, reporterId)) === null
    ) {
      throw new AnswerNotFound();
    }
    return {
      type: this.type,
      routeId,
      subjectId: found.answer.id,
      courseId: found.question.courseId,
      authorId: found.answer.authorId,
      reviewId: null,
      questionId: found.question.id,
      lectureId: found.question.lectureId,
    };
  }

  notFound(): Error {
    return new AnswerNotFound();
  }

  override async beforeFile(
    trx: Transaction<DB>,
    subject: ReportableSubject,
  ): Promise<ReportFilingContext> {
    const lock = await this.qa.lockAnswerAcceptance(trx, subject.subjectId);
    return lock === null ? NO_FILING_CONTEXT : { wasAcceptedAnswer: lock.wasAccepted };
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
    if (subject.questionId === null) return Promise.resolve();
    return this.hints.changed({
      courseId: subject.courseId,
      questionId: subject.questionId,
      lectureId: subject.lectureId,
    });
  }
}
