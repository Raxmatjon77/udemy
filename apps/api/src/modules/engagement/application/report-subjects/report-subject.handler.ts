import type { ReportSubjectType } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  NO_FILING_CONTEXT,
  type ReportableSubject,
  type ReportFilingContext,
} from '../../domain/report';

/**
 * One reportable subject type (design D13): how the reporter's view of it is resolved and which
 * event announces an automatic hide. ReportContent dispatches on `type`; every subject type
 * (REVIEW, REVIEW_REPLY: P5-T12; QUESTION, ANSWER: P5-T13) is registered in
 * `REPORT_SUBJECT_HANDLERS` without touching the command.
 */
export abstract class ReportSubjectHandler {
  abstract readonly type: ReportSubjectType;

  /**
   * The subject as the reporter can see it, resolved from the route id. Throws the subject's
   * `*_not_found` (404) when it does not exist, is deleted, or is not visible to the reporter
   * (a hidden subject is invisible even to its author here: there is nothing to report).
   */
  abstract resolve(routeId: string, reporterId: string): Promise<ReportableSubject>;

  /** The subject's `*_not_found` (the subject vanished between `resolve` and the lock). */
  abstract notFound(): Error;

  /**
   * Runs in the report transaction BEFORE the report is filed (and the subject possibly hidden),
   * to lock and capture what `publishAutoHidden` needs. Locks must follow the subject -> parent
   * order of `@udemy/db` (the report locks the subject row first). Default: nothing.
   */
  beforeFile(_trx: Transaction<DB>, _subject: ReportableSubject): Promise<ReportFilingContext> {
    return Promise.resolve(NO_FILING_CONTEXT);
  }

  /** The `…Hidden` event(s) of an automatic hide (actor null), in the report transaction. */
  abstract publishAutoHidden(
    trx: Transaction<DB>,
    subject: ReportableSubject,
    hiddenAt: Date,
    context: ReportFilingContext,
  ): Promise<void>;

  /**
   * After the auto-hide committed (best effort, never throws): e.g. the `qa.changed` hint of a
   * hidden question or answer. Default: nothing.
   */
  afterAutoHideCommitted(_subject: ReportableSubject): Promise<void> {
    return Promise.resolve();
  }
}

/** Multi-provider token: every `ReportSubjectHandler` of the module (see engagement.module.ts). */
export const REPORT_SUBJECT_HANDLERS = Symbol.for('udemy.engagement.REPORT_SUBJECT_HANDLERS');
