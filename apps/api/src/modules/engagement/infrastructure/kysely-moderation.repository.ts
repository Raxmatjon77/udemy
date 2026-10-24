import { Injectable } from '@nestjs/common';
import {
  MODERATION_ACTIONS,
  type ModerationActionType,
  type ModerationSubjectType,
  MODERATION_SUBJECT_TYPES,
  REPORT_REASONS,
  REPORT_STATUSES,
} from '@udemy/contracts';
import { type DB, moderateSubject, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  ModerationRepository,
  type QueueOptions,
  type QueueRow,
  type SubjectRef,
} from '../application/ports/moderation.repository';
import {
  type ModerationActionRecord,
  type ModerationOutcome,
  type ModerationReportRecord,
  type ModerationSubjectRecord,
  subjectKey,
} from '../domain/moderation';
import { mapEngagementConstraints } from './engagement-constraint-errors';
import { moderationStatusOf, narrow } from './row-mapping';

/** The subject and report table of each moderated type (trusted constants only). */
const TABLES: Readonly<Record<ModerationSubjectType, { subject: string; reports: string }>> =
  Object.freeze({
    REVIEW: { subject: 'engagement.reviews', reports: 'engagement.review_reports' },
    REVIEW_REPLY: {
      subject: 'engagement.review_replies',
      reports: 'engagement.review_reply_reports',
    },
    QUESTION: { subject: 'engagement.questions', reports: 'engagement.question_reports' },
    ANSWER: { subject: 'engagement.answers', reports: 'engagement.answer_reports' },
  });

/**
 * One SELECT per type with the same columns (`ModerationSubjectRecord`). Review replies are
 * addressed by their review id (`route_id`); answers carry their question and its lecture.
 */
const SUBJECT_SELECTS: Readonly<Record<ModerationSubjectType, string>> = Object.freeze({
  REVIEW: `
    SELECT 'REVIEW'::text AS type, r.id, r.id AS route_id, r.course_id, r.user_id AS author_id,
           r.moderation_status, r.deleted_at IS NOT NULL AS deleted, r.created_at,
           NULL::text AS title, r.body, r.rating::int AS rating, r.id AS review_id,
           NULL::uuid AS question_id, NULL::uuid AS lecture_id
      FROM engagement.reviews r`,
  REVIEW_REPLY: `
    SELECT 'REVIEW_REPLY'::text AS type, rr.id, rr.review_id AS route_id, r.course_id,
           rr.author_id, rr.moderation_status, rr.deleted_at IS NOT NULL AS deleted, rr.created_at,
           NULL::text AS title, rr.body, NULL::int AS rating, rr.review_id,
           NULL::uuid AS question_id, NULL::uuid AS lecture_id
      FROM engagement.review_replies rr JOIN engagement.reviews r ON r.id = rr.review_id`,
  QUESTION: `
    SELECT 'QUESTION'::text AS type, q.id, q.id AS route_id, q.course_id, q.author_id,
           q.moderation_status, q.deleted_at IS NOT NULL AS deleted, q.created_at,
           q.title, q.body_md AS body, NULL::int AS rating, NULL::uuid AS review_id,
           q.id AS question_id, q.lecture_id
      FROM engagement.questions q`,
  ANSWER: `
    SELECT 'ANSWER'::text AS type, a.id, a.id AS route_id, q.course_id, a.author_id,
           a.moderation_status, a.deleted_at IS NOT NULL AS deleted, a.created_at,
           NULL::text AS title, a.body_md AS body, NULL::int AS rating, NULL::uuid AS review_id,
           a.question_id, q.lecture_id
      FROM engagement.answers a JOIN engagement.questions q ON q.id = a.question_id`,
});

const SUBJECT_ALIAS: Readonly<Record<ModerationSubjectType, string>> = Object.freeze({
  REVIEW: 'r',
  REVIEW_REPLY: 'rr',
  QUESTION: 'q',
  ANSWER: 'a',
});

interface SubjectRow {
  type: string;
  id: string;
  routeId: string;
  courseId: string;
  authorId: string;
  moderationStatus: string;
  deleted: boolean;
  createdAt: Date;
  title: string | null;
  body: string | null;
  rating: number | null;
  reviewId: string | null;
  questionId: string | null;
  lectureId: string | null;
}

function toSubject(row: SubjectRow): ModerationSubjectRecord {
  return {
    type: narrow(MODERATION_SUBJECT_TYPES, row.type, 'moderation subject type'),
    id: row.id,
    routeId: row.routeId,
    courseId: row.courseId,
    authorId: row.authorId,
    moderationStatus: moderationStatusOf(row.moderationStatus, `${row.type}.moderation_status`),
    deleted: row.deleted,
    createdAt: row.createdAt,
    title: row.title,
    body: row.body,
    rating: row.rating,
    reviewId: row.reviewId,
    questionId: row.questionId,
    lectureId: row.lectureId,
  };
}

/** `(subject_type, subject_id)` pairs as a join source (index: type, id first). */
function refsSource(refs: readonly SubjectRef[]) {
  return sql`unnest(${refs.map((r) => r.type)}::text[], ${refs.map((r) => r.id)}::uuid[]) AS k(subject_type, subject_id)`;
}

/**
 * The admin moderation queue over `engagement.content_reports` (the UNION ALL view of the four
 * report tables) and the admin actions through `@udemy/db` `moderateSubject` (subject row lock,
 * conditional state change, append-only `moderation_actions` row, report resolution), plus the
 * two cases it leaves out (confirming a hide; dismissing reports on deleted content), under the
 * same lock. Every subject's `moderation_status` stays equal to its latest HIDE/RESTORE
 * (`moderation_status_log_ck`, at COMMIT).
 */
@Injectable()
export class KyselyModerationRepository extends ModerationRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async queuePage(options: QueueOptions): Promise<QueueRow[]> {
    const type = options.type === undefined ? sql`` : sql`WHERE subject_type = ${options.type}`;
    const keyset =
      options.after === null
        ? sql``
        : sql`AND (max(created_at), subject_id) < (${options.after.lastReportedAt}::timestamptz, ${options.after.subjectId}::uuid)`;
    const { rows } = await sql<{
      subjectType: string;
      subjectId: string;
      lastReportedAt: Date;
      lastReportedAtKey: string;
    }>`
      SELECT subject_type, subject_id, max(created_at) AS last_reported_at,
             to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_reported_at_key
        FROM engagement.content_reports
       ${type}
       GROUP BY subject_type, subject_id
      HAVING bool_or(status = ${options.status}) ${keyset}
       ORDER BY max(created_at) DESC, subject_id DESC
       LIMIT ${options.limit}::int
    `.execute(this.db);
    return rows.map((r) => ({
      ref: {
        type: narrow(MODERATION_SUBJECT_TYPES, r.subjectType, 'content_reports.subject_type'),
        id: r.subjectId,
      },
      lastReportedAt: r.lastReportedAt,
      lastReportedAtKey: r.lastReportedAtKey,
    }));
  }

  async loadSubjects(
    refs: readonly SubjectRef[],
  ): Promise<ReadonlyMap<string, ModerationSubjectRecord>> {
    const byType = new Map<ModerationSubjectType, string[]>();
    for (const ref of refs) byType.set(ref.type, [...(byType.get(ref.type) ?? []), ref.id]);
    if (byType.size === 0) return new Map();
    const parts = [...byType].map(
      ([type, ids]) =>
        sql`${sql.raw(SUBJECT_SELECTS[type])} WHERE ${sql.raw(SUBJECT_ALIAS[type])}.id = ANY(${ids}::uuid[])`,
    );
    const { rows } = await sql<SubjectRow>`${sql.join(parts, sql` UNION ALL `)}`.execute(this.db);
    return new Map(rows.map((row) => [subjectKey(toSubject(row).type, row.id), toSubject(row)]));
  }

  async resolveRoute(
    type: ModerationSubjectType,
    routeId: string,
  ): Promise<ModerationSubjectRecord | null> {
    let id = routeId;
    if (type === 'REVIEW_REPLY') {
      // the live reply of the review, else its most recent (deleted) one
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM engagement.review_replies WHERE review_id = ${routeId}
         ORDER BY (deleted_at IS NULL) DESC, created_at DESC, id DESC
         LIMIT 1
      `.execute(this.db);
      const reply = rows[0];
      if (reply === undefined) return null;
      id = reply.id;
    }
    const subjects = await this.loadSubjects([{ type, id }]);
    return subjects.get(subjectKey(type, id)) ?? null;
  }

  async reportsOf(
    refs: readonly SubjectRef[],
    perSubject: number,
  ): Promise<ModerationReportRecord[]> {
    if (refs.length === 0) return [];
    const { rows } = await sql<{
      id: string;
      subjectType: string;
      subjectId: string;
      reporterId: string;
      reason: string;
      comment: string | null;
      status: string;
      createdAt: Date;
      resolvedAt: Date | null;
    }>`
      SELECT id, subject_type, subject_id, reporter_id, reason, comment, status, created_at, resolved_at
        FROM (SELECT cr.*, row_number() OVER (PARTITION BY cr.subject_type, cr.subject_id
                                              ORDER BY cr.created_at DESC, cr.id DESC) AS rn
                FROM engagement.content_reports cr
                JOIN ${refsSource(refs)} USING (subject_type, subject_id)) ranked
       WHERE rn <= ${perSubject}::int
       ORDER BY subject_type, subject_id, created_at DESC, id DESC
    `.execute(this.db);
    return rows.map((r) => ({
      id: r.id,
      subjectType: narrow(MODERATION_SUBJECT_TYPES, r.subjectType, 'content_reports.subject_type'),
      subjectId: r.subjectId,
      reporterId: r.reporterId,
      reason: narrow(REPORT_REASONS, r.reason, 'content_reports.reason'),
      comment: r.comment,
      status: narrow(REPORT_STATUSES, r.status, 'content_reports.status'),
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    }));
  }

  async openReportCounts(refs: readonly SubjectRef[]): Promise<ReadonlyMap<string, number>> {
    if (refs.length === 0) return new Map();
    const { rows } = await sql<{ subjectType: string; subjectId: string; n: number }>`
      SELECT cr.subject_type, cr.subject_id, count(*)::int AS n
        FROM engagement.content_reports cr
        JOIN ${refsSource(refs)} USING (subject_type, subject_id)
       WHERE cr.status = 'OPEN'
       GROUP BY cr.subject_type, cr.subject_id
    `.execute(this.db);
    return new Map(
      rows.map((r) => [
        subjectKey(
          narrow(MODERATION_SUBJECT_TYPES, r.subjectType, 'content_reports.subject_type'),
          r.subjectId,
        ),
        r.n,
      ]),
    );
  }

  async actionsOf(refs: readonly SubjectRef[]): Promise<ModerationActionRecord[]> {
    if (refs.length === 0) return [];
    // moderation_actions_subject_type_subject_id_occurred_at_idx
    const { rows } = await sql<{
      id: string;
      subjectType: string;
      subjectId: string;
      action: string;
      actorId: string | null;
      reason: string | null;
      occurredAt: Date;
    }>`
      SELECT m.id, m.subject_type, m.subject_id, m.action, m.actor_id, m.reason, m.occurred_at
        FROM engagement.moderation_actions m
        JOIN ${refsSource(refs)} USING (subject_type, subject_id)
       ORDER BY m.occurred_at, m.id
    `.execute(this.db);
    return rows.map((r) => ({
      id: r.id,
      subjectType: narrow(
        MODERATION_SUBJECT_TYPES,
        r.subjectType,
        'moderation_actions.subject_type',
      ),
      subjectId: r.subjectId,
      action: narrow(MODERATION_ACTIONS, r.action, 'moderation_actions.action'),
      actorId: r.actorId,
      reason: r.reason,
      occurredAt: r.occurredAt,
    }));
  }

  async moderate(
    trx: Transaction<DB>,
    input: { ref: SubjectRef; action: ModerationActionType; actorId: string; reason: string },
  ): Promise<ModerationOutcome> {
    const { ref, action, actorId, reason } = input;
    const result = await mapEngagementConstraints(() =>
      moderateSubject(trx, {
        subjectType: ref.type,
        subjectId: ref.id,
        action,
        actorId,
        reason,
      }),
    );
    if (result.outcome === 'APPLIED') {
      return {
        outcome: 'APPLIED',
        moderationStatus: result.moderationStatus,
        statusChanged: action !== 'DISMISS_REPORTS',
        resolvedReports: result.resolvedReports,
      };
    }
    if (result.outcome === 'NOOP') {
      // Already hidden (an auto-hide, or a report filed while the hide committed) but with
      // open reports: the admin confirms the hide; the state does not change.
      if (action !== 'HIDE' || result.moderationStatus !== 'HIDDEN') return { outcome: 'NOOP' };
      const resolved = await this.resolveAndLog(trx, input, 'ACTIONED');
      return resolved === 0
        ? { outcome: 'NOOP' }
        : {
            outcome: 'APPLIED',
            moderationStatus: 'HIDDEN',
            statusChanged: false,
            resolvedReports: resolved,
          };
    }
    // moderateSubject only sees non-deleted rows: deleted content is frozen (immutability
    // triggers), but its open reports may still be dismissed so the queue can be cleared.
    const { rows } = await sql<{ moderationStatus: string }>`
      SELECT moderation_status FROM ${sql.raw(TABLES[ref.type].subject)}
       WHERE id = ${ref.id} FOR NO KEY UPDATE
    `.execute(trx);
    const row = rows[0];
    if (row === undefined) return { outcome: 'NOT_FOUND' };
    if (action !== 'DISMISS_REPORTS') return { outcome: 'DELETED' };
    const resolved = await this.resolveAndLog(trx, input, 'DISMISSED');
    return resolved === 0
      ? { outcome: 'NOOP' }
      : {
          outcome: 'APPLIED',
          moderationStatus: moderationStatusOf(row.moderationStatus, 'moderation_status'),
          statusChanged: false,
          resolvedReports: resolved,
        };
  }

  /** Resolves the subject's OPEN reports and, if any, appends the audit row (subject locked). */
  private async resolveAndLog(
    trx: Transaction<DB>,
    input: { ref: SubjectRef; action: ModerationActionType; actorId: string; reason: string },
    status: 'ACTIONED' | 'DISMISSED',
  ): Promise<number> {
    const updated = await sql`
      UPDATE ${sql.raw(TABLES[input.ref.type].reports)}
         SET status = ${status}, resolved_at = now(), resolved_by = ${input.actorId}
       WHERE subject_id = ${input.ref.id} AND status = 'OPEN'
    `.execute(trx);
    const resolved = Number(updated.numAffectedRows ?? 0n);
    if (resolved > 0) {
      await mapEngagementConstraints(() =>
        sql`
          INSERT INTO engagement.moderation_actions (subject_type, subject_id, action, actor_id, reason)
          VALUES (${input.ref.type}, ${input.ref.id}, ${input.action}, ${input.actorId}, ${input.reason})
        `.execute(trx),
      );
    }
    return resolved;
  }

  async transactionNow(trx: Transaction<DB>): Promise<Date> {
    const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    const now = rows[0]?.now;
    if (now === undefined) throw new Error('SELECT now() returned no row');
    return now;
  }
}
