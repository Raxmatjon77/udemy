import type { ReportReason, ReportStatus, ReportSubjectType } from '@udemy/contracts';

/**
 * Reports and auto-hide (Phase 5 learning experience design D13, §4 Report). One report table
 * per subject type (`UNIQUE (subject, reporter)`); `ENGAGEMENT_AUTO_HIDE_REPORTS` distinct OPEN
 * reports hide a VISIBLE subject automatically (a `moderation_actions` row without an actor).
 */

/**
 * A subject the reporter can see, resolved from the route id. For REVIEW_REPLY the route
 * carries the REVIEW id (contracts `REPORT_SUBJECT_PATHS`), so `subjectId` (the table row) and
 * `routeId` differ.
 */
export interface ReportableSubject {
  readonly type: ReportSubjectType;
  /** The id in the URL and in the `Report` response. */
  readonly routeId: string;
  /** The primary key of the subject row (what the report table references). */
  readonly subjectId: string;
  readonly courseId: string;
  readonly authorId: string;
  /** For replies: the review the reply belongs to (events carry it). */
  readonly reviewId: string | null;
  /** For questions: the question itself; for answers: their question (events, hints). */
  readonly questionId: string | null;
  /** For Q&A: the lecture of the question (null = general; the `qa.changed` hint). */
  readonly lectureId: string | null;
}

/**
 * What a handler captured inside the report transaction, before the subject could be hidden:
 * whether the answer was the accepted one (an automatic hide clears it, `QuestionReopened`).
 */
export interface ReportFilingContext {
  readonly wasAcceptedAnswer: boolean;
}

export const NO_FILING_CONTEXT: ReportFilingContext = Object.freeze({ wasAcceptedAnswer: false });

/** The caller's report as stored. */
export interface ReportRecord {
  readonly id: string;
  readonly reason: ReportReason;
  readonly comment: string | null;
  readonly status: ReportStatus;
  readonly createdAt: Date;
  /** Set once ACTIONED (e.g. by the auto-hide this report triggered) or DISMISSED. */
  readonly resolvedAt: Date | null;
}

export type ReportOutcome =
  /** The subject vanished (deleted) between the visibility check and the lock. */
  | { readonly outcome: 'NOT_FOUND' }
  | {
      /** REPORTED: this call created the report (201); ALREADY_REPORTED: a repeat (200). */
      readonly outcome: 'REPORTED' | 'ALREADY_REPORTED';
      readonly openReports: number;
      /** This call hid the subject (emit the `…Hidden` event in the same transaction). */
      readonly autoHidden: boolean;
    };
