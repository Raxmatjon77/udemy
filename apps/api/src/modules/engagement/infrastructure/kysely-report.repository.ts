import { Injectable } from '@nestjs/common';
import { REPORT_REASONS, REPORT_STATUSES, type ReportSubjectType } from '@udemy/contracts';
import { type DB, type Executor, reportContent, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { type FileReportInput, ReportRepository } from '../application/ports/report.repository';
import type { ReportOutcome, ReportRecord } from '../domain/report';
import { mapEngagementConstraints } from './engagement-constraint-errors';
import { narrow } from './row-mapping';

/** One report table per subject type (identical shapes; trusted constants only). */
const REPORT_TABLES: Readonly<Record<ReportSubjectType, string>> = Object.freeze({
  REVIEW: 'engagement.review_reports',
  REVIEW_REPLY: 'engagement.review_reply_reports',
  QUESTION: 'engagement.question_reports',
  ANSWER: 'engagement.answer_reports',
});

interface ReportRow {
  id: string;
  reason: string;
  comment: string | null;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** The report tables through `@udemy/db` `reportContent` (R9: subject row lock, then count). */
@Injectable()
export class KyselyReportRepository extends ReportRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  file(trx: Transaction<DB>, input: FileReportInput): Promise<ReportOutcome> {
    return mapEngagementConstraints(() =>
      reportContent(trx, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reporterId: input.reporterId,
        reason: input.reason,
        comment: input.comment,
        autoHideThreshold: input.autoHideThreshold,
      }),
    );
  }

  async findByReporter(
    subjectType: ReportSubjectType,
    subjectId: string,
    reporterId: string,
    ex?: Executor,
  ): Promise<ReportRecord | null> {
    const { rows } = await sql<ReportRow>`
      SELECT id, reason, comment, status, created_at, resolved_at
        FROM ${sql.raw(REPORT_TABLES[subjectType])}
       WHERE subject_id = ${subjectId} AND reporter_id = ${reporterId}
    `.execute(ex ?? this.db);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      reason: narrow(REPORT_REASONS, row.reason, 'reports.reason'),
      comment: row.comment,
      status: narrow(REPORT_STATUSES, row.status, 'reports.status'),
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }
}
