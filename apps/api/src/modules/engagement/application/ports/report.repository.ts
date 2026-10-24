import type { ReportReason, ReportSubjectType } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { ReportOutcome, ReportRecord } from '../../domain/report';

export interface FileReportInput {
  readonly subjectType: ReportSubjectType;
  /** The subject row's primary key. */
  readonly subjectId: string;
  readonly reporterId: string;
  readonly reason: ReportReason;
  readonly comment: string | null;
  /** `ENGAGEMENT_AUTO_HIDE_REPORTS`. */
  readonly autoHideThreshold: number;
}

/**
 * The four `*_reports` tables and the auto-hide (`@udemy/db` `reportContent`, race R9: the
 * subject row is locked before the insert and the open-report count).
 */
export abstract class ReportRepository {
  abstract file(trx: Transaction<DB>, input: FileReportInput): Promise<ReportOutcome>;

  /** The reporter's report on the subject (one per reporter). */
  abstract findByReporter(
    subjectType: ReportSubjectType,
    subjectId: string,
    reporterId: string,
    ex?: Executor,
  ): Promise<ReportRecord | null>;
}
