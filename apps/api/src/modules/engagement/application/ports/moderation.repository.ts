import type {
  ModerationActionType,
  ModerationSubjectType,
  ReportStatus,
  ReportSubjectType,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import type {
  ModerationActionRecord,
  ModerationOutcome,
  ModerationReportRecord,
  ModerationSubjectRecord,
} from '../../domain/moderation';

export interface SubjectRef {
  readonly type: ModerationSubjectType;
  /** The subject row id. */
  readonly id: string;
}

export interface QueueKeyset {
  /** `max(created_at)` of the subject's reports, exact SQL text. */
  readonly lastReportedAt: string;
  /** The subject row id. */
  readonly subjectId: string;
}

export interface QueueRow {
  readonly ref: SubjectRef;
  readonly lastReportedAt: Date;
  readonly lastReportedAtKey: string;
}

export interface QueueOptions {
  readonly type?: ReportSubjectType | undefined;
  readonly status: ReportStatus;
  readonly after: QueueKeyset | null;
  readonly limit: number;
}

/**
 * The moderation queue (`engagement.content_reports`) and the admin actions (`@udemy/db`
 * `moderateSubject`, under the subject row lock, with the append-only `moderation_actions`
 * audit row). Subjects are rows; mapping route ids (REVIEW_REPLY = review id) happens here.
 */
export abstract class ModerationRepository {
  /** One item per reported subject with >= 1 report in `status`, newest report first. */
  abstract queuePage(options: QueueOptions): Promise<QueueRow[]>;

  /** The subject rows (any state); missing rows are absent from the map (`subjectKey`). */
  abstract loadSubjects(
    refs: readonly SubjectRef[],
  ): Promise<ReadonlyMap<string, ModerationSubjectRecord>>;

  /**
   * The subject addressed by a route id: the row itself, or for REVIEW_REPLY the review's live
   * reply (else its most recent deleted one). Null when there is none.
   */
  abstract resolveRoute(
    type: ModerationSubjectType,
    routeId: string,
  ): Promise<ModerationSubjectRecord | null>;

  /** Newest first, at most `perSubject` per subject. */
  abstract reportsOf(
    refs: readonly SubjectRef[],
    perSubject: number,
  ): Promise<ModerationReportRecord[]>;

  /** OPEN report count per subject (`subjectKey`; absent = 0). */
  abstract openReportCounts(refs: readonly SubjectRef[]): Promise<ReadonlyMap<string, number>>;

  /** The audit log of the subjects, oldest first. */
  abstract actionsOf(refs: readonly SubjectRef[]): Promise<ModerationActionRecord[]>;

  /**
   * An admin action under the subject row lock: HIDE (open reports ACTIONED; on hidden content
   * with open reports it only confirms the hide), RESTORE (open reports DISMISSED) or
   * DISMISS_REPORTS (also on deleted content, so the queue can be cleared).
   */
  abstract moderate(
    trx: Transaction<DB>,
    input: {
      ref: SubjectRef;
      action: ModerationActionType;
      actorId: string;
      reason: string;
    },
  ): Promise<ModerationOutcome>;

  /** The transaction's `now()` (the action's `occurred_at`, for event timestamps). */
  abstract transactionNow(trx: Transaction<DB>): Promise<Date>;
}
