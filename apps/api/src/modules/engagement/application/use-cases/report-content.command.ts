import { Inject, Injectable } from '@nestjs/common';
import type { Report, ReportReason, ReportSubjectType } from '@udemy/contracts';
import { CannotReportOwnContent } from '../../domain/engagement.errors';
import { EngagementSettings } from '../engagement-settings';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { ReportRepository } from '../ports/report.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import {
  REPORT_SUBJECT_HANDLERS,
  type ReportSubjectHandler,
} from '../report-subjects/report-subject.handler';

export interface ReportContentInput {
  readonly subjectType: ReportSubjectType;
  /** The `:subjectId` route param (for REVIEW_REPLY: the review id). */
  readonly routeId: string;
  readonly reporterId: string;
  readonly reason: ReportReason;
  readonly comment: string | null;
}

export interface ReportContentResult {
  readonly report: Report;
  /** True for a new report (201); false for a repeat (200, the existing report). */
  readonly created: boolean;
}

/**
 * `ReportContent` (design §5, D13, race R9). The reporter must be able to see the subject and
 * must not be its author; then, in one transaction, `@udemy/db` locks the subject row, inserts
 * the report (ON CONFLICT DO NOTHING: a repeat returns the existing report) and counts the OPEN
 * reports in a new statement. Reaching `ENGAGEMENT_AUTO_HIDE_REPORTS` hides the subject (a
 * `moderation_actions` row without an actor, the open reports ACTIONED) and the `…Hidden` event
 * is written in the same transaction.
 *
 * Errors: 404 (the subject's `*_not_found`), 422 `cannot_report_own_content`, 429 (30 per 24 h).
 */
@Injectable()
export class ReportContentCommand {
  private readonly handlers: ReadonlyMap<ReportSubjectType, ReportSubjectHandler>;

  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly reports: ReportRepository,
    private readonly settings: EngagementSettings,
    private readonly tx: TransactionRunner,
    @Inject(REPORT_SUBJECT_HANDLERS) handlers: readonly ReportSubjectHandler[],
  ) {
    this.handlers = new Map(handlers.map((h) => [h.type, h]));
  }

  async execute(input: ReportContentInput): Promise<ReportContentResult> {
    const handler = this.handlers.get(input.subjectType);
    if (handler === undefined) {
      throw new Error(`No ReportSubjectHandler registered for ${input.subjectType}`);
    }
    await this.rateLimiter.hit('report', input.reporterId);
    const subject = await handler.resolve(input.routeId, input.reporterId);
    if (subject.authorId === input.reporterId) throw new CannotReportOwnContent();

    return this.tx.run(async (trx) => {
      const filed = await this.reports.file(trx, {
        subjectType: subject.type,
        subjectId: subject.subjectId,
        reporterId: input.reporterId,
        reason: input.reason,
        comment: input.comment,
        autoHideThreshold: this.settings.autoHideReports,
      });
      if (filed.outcome === 'NOT_FOUND') throw handler.notFound();
      const report = await this.reports.findByReporter(
        subject.type,
        subject.subjectId,
        input.reporterId,
        trx,
      );
      if (report === null)
        throw new Error(`report on ${subject.type} ${subject.subjectId} vanished`);
      if (filed.autoHidden) {
        // The auto-hide resolved this very report (ACTIONED) at the transaction's now().
        await handler.publishAutoHidden(trx, subject, report.resolvedAt ?? report.createdAt);
      }
      return {
        created: filed.outcome === 'REPORTED',
        report: {
          id: report.id,
          subjectType: subject.type,
          subjectId: subject.routeId,
          reason: report.reason,
          comment: report.comment,
          status: report.status,
          createdAt: report.createdAt.toISOString(),
        },
      };
    });
  }
}
