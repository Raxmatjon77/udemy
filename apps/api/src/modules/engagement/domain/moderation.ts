import type {
  ModerationActionType,
  ModerationStatus,
  ModerationSubjectType,
  ReportReason,
  ReportStatus,
} from '@udemy/contracts';

/**
 * Admin moderation (design D13, §5 AdminListReports / AdminHide / AdminRestore /
 * AdminDismissReports). Every subject is a row of its own table; review replies are addressed
 * in URLs by their REVIEW id (contracts `REPORT_SUBJECT_PATHS`), while the report tables, the
 * `content_reports` view and `moderation_actions` store the reply's own id. `routeId` is the id
 * the API shows and accepts; `id` is the row.
 */
export interface ModerationSubjectRecord {
  readonly type: ModerationSubjectType;
  /** The subject row's primary key (what reports and `moderation_actions` reference). */
  readonly id: string;
  /** The id in the URL and in every moderation response (REVIEW_REPLY: the review id). */
  readonly routeId: string;
  readonly courseId: string;
  readonly authorId: string;
  readonly moderationStatus: ModerationStatus;
  readonly deleted: boolean;
  readonly createdAt: Date;
  /** Questions only. */
  readonly title: string | null;
  /** Markdown for questions and answers, plain text for reviews and replies (may be null). */
  readonly body: string | null;
  /** Reviews only. */
  readonly rating: number | null;
  /** Replies (their review) and reviews (themselves). */
  readonly reviewId: string | null;
  /** Questions (themselves) and answers (their question). */
  readonly questionId: string | null;
  /** Q&A: the question's lecture. */
  readonly lectureId: string | null;
}

/** `typeKey(type, id)`: a map key of a subject row. */
export function subjectKey(type: ModerationSubjectType, id: string): string {
  return `${type}:${id}`;
}

export interface ModerationReportRecord {
  readonly id: string;
  readonly subjectType: ModerationSubjectType;
  /** The subject row id. */
  readonly subjectId: string;
  readonly reporterId: string;
  readonly reason: ReportReason;
  readonly comment: string | null;
  readonly status: ReportStatus;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface ModerationActionRecord {
  readonly id: string;
  readonly subjectType: ModerationSubjectType;
  /** The subject row id. */
  readonly subjectId: string;
  readonly action: ModerationActionType;
  /** Null = AUTO (the report threshold). */
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

/** Admin action names of the routes (`/admin/moderation/{type}/:id/{action}`). */
export const ADMIN_MODERATION_ACTIONS = {
  hide: 'HIDE',
  restore: 'RESTORE',
  'dismiss-reports': 'DISMISS_REPORTS',
} as const satisfies Record<string, ModerationActionType>;
export type AdminModerationRouteAction = keyof typeof ADMIN_MODERATION_ACTIONS;

export type ModerationOutcome =
  /** No such row. */
  | { readonly outcome: 'NOT_FOUND' }
  /** HIDE/RESTORE of deleted content (frozen by the immutability triggers). */
  | { readonly outcome: 'DELETED' }
  /** Nothing to do (already in that state / no open reports); nothing written. */
  | { readonly outcome: 'NOOP' }
  | {
      readonly outcome: 'APPLIED';
      readonly moderationStatus: ModerationStatus;
      /** False when a HIDE only confirmed an already hidden subject (its reports ACTIONED). */
      readonly statusChanged: boolean;
      readonly resolvedReports: number;
    };
