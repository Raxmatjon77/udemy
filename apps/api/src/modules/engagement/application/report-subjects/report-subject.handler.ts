import type { ReportSubjectType } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import type { ReportableSubject } from '../../domain/report';

/**
 * One reportable subject type (design D13): how the reporter's view of it is resolved and which
 * event announces an automatic hide. ReportContent dispatches on `type`; P5-T13 adds the
 * QUESTION and ANSWER handlers (Q&A visibility = learner or owner access) to
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

  /** The `…Hidden` event of an automatic hide (actor null), in the report transaction. */
  abstract publishAutoHidden(
    trx: Transaction<DB>,
    subject: ReportableSubject,
    hiddenAt: Date,
  ): Promise<void>;
}

/** Multi-provider token: every `ReportSubjectHandler` of the module (see engagement.module.ts). */
export const REPORT_SUBJECT_HANDLERS = Symbol.for('udemy.engagement.REPORT_SUBJECT_HANDLERS');
