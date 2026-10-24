import type {
  ModerationAction,
  ModerationQueueItem,
  ModerationReport,
  ModerationSubject,
  PersonRef,
} from '@udemy/contracts';
import type {
  ModerationActionRecord,
  ModerationReportRecord,
  ModerationSubjectRecord,
} from '../domain/moderation';
import { personOf } from './people';

type People = ReadonlyMap<string, PersonRef>;

const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** Every user a moderation view mentions (author, reporters, actors). */
export function moderationPeopleIds(
  subjects: readonly ModerationSubjectRecord[],
  reports: readonly ModerationReportRecord[],
  actions: readonly ModerationActionRecord[],
): string[] {
  return [
    ...subjects.map((s) => s.authorId),
    ...reports.map((r) => r.reporterId),
    ...actions.flatMap((a) => (a.actorId === null ? [] : [a.actorId])),
  ];
}

/**
 * Records reference the subject ROW; every moderation response uses the ROUTE id (for
 * REVIEW_REPLY the review id, contracts `REPORT_SUBJECT_PATHS`), so that the admin UI can
 * call the action routes with what it was shown.
 */
function toAction(
  a: ModerationActionRecord,
  subject: ModerationSubjectRecord,
  people: People,
): ModerationAction {
  return {
    id: a.id,
    subjectType: a.subjectType,
    subjectId: subject.routeId,
    action: a.action,
    actor: a.actorId === null ? null : personOf(people, a.actorId),
    reason: a.reason,
    occurredAt: a.occurredAt.toISOString(),
  };
}

function toReport(
  r: ModerationReportRecord,
  subject: ModerationSubjectRecord,
  people: People,
): ModerationReport {
  return {
    id: r.id,
    subjectType: r.subjectType,
    subjectId: subject.routeId,
    reason: r.reason,
    comment: r.comment,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    reporter: personOf(people, r.reporterId),
    resolvedAt: isoOrNull(r.resolvedAt),
  };
}

export function toModerationSubject(
  subject: ModerationSubjectRecord,
  extras: {
    readonly courseTitle: string | null;
    readonly openReportCount: number;
    /** This subject's actions, oldest first. */
    readonly actions: readonly ModerationActionRecord[];
    readonly people: People;
  },
): ModerationSubject {
  return {
    subjectType: subject.type,
    subjectId: subject.routeId,
    courseId: subject.courseId,
    courseTitle: extras.courseTitle,
    moderationStatus: subject.moderationStatus,
    openReportCount: extras.openReportCount,
    actions: extras.actions.map((a) => toAction(a, subject, extras.people)),
  };
}

export function toModerationQueueItem(
  subject: ModerationSubjectRecord,
  extras: {
    readonly courseTitle: string | null;
    readonly openReportCount: number;
    readonly actions: readonly ModerationActionRecord[];
    /** This subject's reports, newest first, at most 20. */
    readonly reports: readonly ModerationReportRecord[];
    readonly lastReportedAt: Date;
    readonly people: People;
  },
): ModerationQueueItem {
  return {
    ...toModerationSubject(subject, extras),
    preview: {
      title: subject.title,
      body: subject.body,
      bodyIsMarkdown: subject.type === 'QUESTION' || subject.type === 'ANSWER',
      rating: subject.rating,
      author: personOf(extras.people, subject.authorId),
      createdAt: subject.createdAt.toISOString(),
      deleted: subject.deleted,
    },
    reports: extras.reports.map((r) => toReport(r, subject, extras.people)),
    lastReportedAt: extras.lastReportedAt.toISOString(),
  };
}
