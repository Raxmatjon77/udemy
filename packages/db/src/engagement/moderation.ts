/**
 * Reports and moderation (docs/phase-5-schema-design.md §8.5, D13, race R9).
 *
 * R9: ReportContent locks the SUBJECT row `FOR NO KEY UPDATE` before inserting the report and
 * counting open reports in a new statement; without it three concurrent reporters each count
 * <= 2 and nobody hides. The auto-hide, its `moderation_actions` (actor NULL) row and the
 * ACTIONED updates happen in that same transaction. Every subject's moderation_status equals
 * its latest HIDE/RESTORE action (moderation_status_log_ck, checked at COMMIT).
 */
import { sql } from 'kysely';
import { assertIntInRange, assertOneOf } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';

/** `moderation_actions.subject_type`; ANNOUNCEMENT is delete-only (open point 2). */
export const MODERATED_SUBJECT_TYPES = ['REVIEW', 'REVIEW_REPLY', 'QUESTION', 'ANSWER'] as const;
export type ModeratedSubjectType = (typeof MODERATED_SUBJECT_TYPES)[number];

/** `*_reports_reason_ck` (= contracts REPORT_REASONS). */
export const REPORT_REASONS = [
  'SPAM',
  'ABUSE',
  'HARASSMENT',
  'OFF_TOPIC',
  'INAPPROPRIATE',
  'OTHER',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const TABLES: Readonly<Record<ModeratedSubjectType, { subject: string; reports: string }>> =
  Object.freeze({
    REVIEW: { subject: 'engagement.reviews', reports: 'engagement.review_reports' },
    REVIEW_REPLY: {
      subject: 'engagement.review_replies',
      reports: 'engagement.review_reply_reports',
    },
    QUESTION: { subject: 'engagement.questions', reports: 'engagement.question_reports' },
    ANSWER: { subject: 'engagement.answers', reports: 'engagement.answer_reports' },
  });

export interface ReportContentInput {
  subjectType: ModeratedSubjectType;
  subjectId: string;
  reporterId: string;
  reason: ReportReason;
  comment: string | null;
  /** ENGAGEMENT_AUTO_HIDE_REPORTS (default 3): distinct OPEN reports that hide the subject. */
  autoHideThreshold: number;
}

export type ReportContentResult =
  /** No such subject, or it is deleted (-> the subject's *_not_found). */
  | { outcome: 'NOT_FOUND' }
  | {
      /** REPORTED = this call created the report; ALREADY_REPORTED = repeat (idempotent 200). */
      outcome: 'REPORTED' | 'ALREADY_REPORTED';
      openReports: number;
      /** This call hid the subject (-> ContentAutoHidden after commit). */
      autoHidden: boolean;
    };

/** ReportContent (R9), in the caller's transaction. Own content -> 23514 `*_reports_own_content_ck`. */
export async function reportContent(
  executor: Executor,
  input: ReportContentInput,
): Promise<ReportContentResult> {
  assertOneOf('subjectType', input.subjectType, MODERATED_SUBJECT_TYPES);
  assertOneOf('reason', input.reason, REPORT_REASONS);
  assertIntInRange('autoHideThreshold', input.autoHideThreshold, 1, 1000);
  const trx = requireTransaction(executor, 'reportContent');
  const t = TABLES[input.subjectType];
  const subject = await sql<{ moderationStatus: string }>`
    SELECT moderation_status FROM ${sql.raw(t.subject)}
     WHERE id = ${input.subjectId} AND deleted_at IS NULL
       FOR NO KEY UPDATE
  `.execute(trx);
  const status = subject.rows[0]?.moderationStatus;
  if (status === undefined) return { outcome: 'NOT_FOUND' };

  const inserted = await sql`
    INSERT INTO ${sql.raw(t.reports)} (subject_id, reporter_id, reason, comment)
    VALUES (${input.subjectId}, ${input.reporterId}, ${input.reason}, ${input.comment})
    ON CONFLICT (subject_id, reporter_id) DO NOTHING
  `.execute(trx);
  const created = Number(inserted.numAffectedRows ?? 0n) === 1;
  // new statement after the subject lock: sees every report committed while we waited
  const counted = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ${sql.raw(t.reports)} WHERE subject_id = ${input.subjectId} AND status = 'OPEN'
  `.execute(trx);
  const openReports = counted.rows[0]?.n ?? 0;
  let autoHidden = false;
  if (created && status === 'VISIBLE' && openReports >= input.autoHideThreshold) {
    await hide(trx, input.subjectType, input.subjectId, null, null);
    await resolveOpenReports(trx, input.subjectType, input.subjectId, 'ACTIONED', null);
    autoHidden = true;
  }
  return { outcome: created ? 'REPORTED' : 'ALREADY_REPORTED', openReports, autoHidden };
}

async function hide(
  executor: Executor,
  type: ModeratedSubjectType,
  id: string,
  actorId: string | null,
  reason: string | null,
): Promise<void> {
  await sql`UPDATE ${sql.raw(TABLES[type].subject)} SET moderation_status = 'HIDDEN' WHERE id = ${id}`.execute(
    executor,
  );
  await sql`
    INSERT INTO engagement.moderation_actions (subject_type, subject_id, action, actor_id, reason)
    VALUES (${type}, ${id}, 'HIDE', ${actorId}, ${reason})
  `.execute(executor);
}

async function resolveOpenReports(
  executor: Executor,
  type: ModeratedSubjectType,
  id: string,
  status: 'ACTIONED' | 'DISMISSED',
  actorId: string | null,
): Promise<number> {
  const result = await sql`
    UPDATE ${sql.raw(TABLES[type].reports)} SET status = ${status}, resolved_at = now(), resolved_by = ${actorId}
     WHERE subject_id = ${id} AND status = 'OPEN'
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n);
}

export interface ModerateSubjectInput {
  subjectType: ModeratedSubjectType;
  subjectId: string;
  action: 'HIDE' | 'RESTORE' | 'DISMISS_REPORTS';
  actorId: string;
  /** 10..2000 characters (moderation_actions_reason_ck). */
  reason: string;
}

export type ModerateSubjectResult =
  | { outcome: 'NOT_FOUND' }
  /** Nothing to do (already in that state / no open reports); nothing written. */
  | { outcome: 'NOOP'; moderationStatus: 'VISIBLE' | 'HIDDEN' }
  | { outcome: 'APPLIED'; moderationStatus: 'VISIBLE' | 'HIDDEN'; resolvedReports: number };

/**
 * Admin HIDE (open reports -> ACTIONED), RESTORE (open reports -> DISMISSED, contracts) or
 * DISMISS_REPORTS, under the subject row lock, with the audit row.
 */
export async function moderateSubject(
  executor: Executor,
  input: ModerateSubjectInput,
): Promise<ModerateSubjectResult> {
  assertOneOf('subjectType', input.subjectType, MODERATED_SUBJECT_TYPES);
  assertOneOf('action', input.action, ['HIDE', 'RESTORE', 'DISMISS_REPORTS'] as const);
  if (typeof input.reason !== 'string' || input.reason.length < 10 || input.reason.length > 2000) {
    throw new RangeError('a moderation reason must have 10..2000 characters');
  }
  const trx = requireTransaction(executor, 'moderateSubject');
  const t = TABLES[input.subjectType];
  const subject = await sql<{ moderationStatus: 'VISIBLE' | 'HIDDEN' }>`
    SELECT moderation_status FROM ${sql.raw(t.subject)}
     WHERE id = ${input.subjectId} AND deleted_at IS NULL
       FOR NO KEY UPDATE
  `.execute(trx);
  const status = subject.rows[0]?.moderationStatus;
  if (status === undefined) return { outcome: 'NOT_FOUND' };

  if (input.action === 'HIDE') {
    if (status === 'HIDDEN') return { outcome: 'NOOP', moderationStatus: status };
    await hide(trx, input.subjectType, input.subjectId, input.actorId, input.reason);
    const n = await resolveOpenReports(
      trx,
      input.subjectType,
      input.subjectId,
      'ACTIONED',
      input.actorId,
    );
    return { outcome: 'APPLIED', moderationStatus: 'HIDDEN', resolvedReports: n };
  }
  if (input.action === 'RESTORE') {
    if (status === 'VISIBLE') return { outcome: 'NOOP', moderationStatus: status };
    await sql`UPDATE ${sql.raw(t.subject)} SET moderation_status = 'VISIBLE' WHERE id = ${input.subjectId}`.execute(
      trx,
    );
    await sql`
      INSERT INTO engagement.moderation_actions (subject_type, subject_id, action, actor_id, reason)
      VALUES (${input.subjectType}, ${input.subjectId}, 'RESTORE', ${input.actorId}, ${input.reason})
    `.execute(trx);
    const n = await resolveOpenReports(
      trx,
      input.subjectType,
      input.subjectId,
      'DISMISSED',
      input.actorId,
    );
    return { outcome: 'APPLIED', moderationStatus: 'VISIBLE', resolvedReports: n };
  }
  const n = await resolveOpenReports(
    trx,
    input.subjectType,
    input.subjectId,
    'DISMISSED',
    input.actorId,
  );
  if (n === 0) return { outcome: 'NOOP', moderationStatus: status };
  await sql`
    INSERT INTO engagement.moderation_actions (subject_type, subject_id, action, actor_id, reason)
    VALUES (${input.subjectType}, ${input.subjectId}, 'DISMISS_REPORTS', ${input.actorId}, ${input.reason})
  `.execute(trx);
  return { outcome: 'APPLIED', moderationStatus: status, resolvedReports: n };
}
