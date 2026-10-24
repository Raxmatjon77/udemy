import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_KIND_META,
  type NotificationApp,
  type NotificationKind,
  type NotificationSubjectType,
} from '@udemy/contracts';
import { type DB, sql, type Transaction } from '@udemy/db';

export interface NewNotificationRow {
  readonly userId: string;
  readonly app: NotificationApp;
  readonly kind: NotificationKind;
  /** Validated against `NOTIFICATION_PAYLOAD_SCHEMAS[kind]` by the caller. */
  readonly payload: unknown;
  readonly subjectId: string | null;
  readonly sourceEventId: string;
}

export interface RedactedNotification {
  readonly id: string;
  readonly userId: string;
  readonly app: NotificationApp;
}

/** Kinds whose payload quotes user-authored text (`NOTIFICATION_KIND_META[kind].redactable`). */
export type RedactableKind =
  | 'QA_NEW_QUESTION'
  | 'QA_NEW_ANSWER'
  | 'QA_RESOLVED'
  | 'REVIEW_NEW'
  | 'REVIEW_REPLY'
  | 'ANNOUNCEMENT';

/**
 * The JSON patch that turns a payload of each redactable kind into its redacted form: exactly
 * what contracts `redactNotificationPayload` does (texts -> null, `redacted: true`); a unit test
 * keeps the two in step. `notifications_redacted_ck` checks `payload @> {"redacted": true}`.
 */
export const REDACTION_PATCHES: Readonly<Record<RedactableKind, Readonly<Record<string, null>>>> =
  Object.freeze({
    QA_NEW_QUESTION: { questionTitle: null },
    QA_NEW_ANSWER: { questionTitle: null, excerpt: null },
    QA_RESOLVED: { questionTitle: null },
    REVIEW_NEW: { excerpt: null },
    REVIEW_REPLY: { excerpt: null },
    ANNOUNCEMENT: { title: null },
  });

const REDACTABLE_KINDS = Object.keys(REDACTION_PATCHES) as RedactableKind[];

/**
 * SQL of `notifications.notifications` for the worker (the only writer, design D14). All at
 * READ COMMITTED, in the caller's transaction.
 *
 * - Inserts are idempotent on `notifications_user_id_kind_source_event_id_uq`
 *   (`ON CONFLICT DO NOTHING RETURNING id`): a replay returns null, so the caller pushes and
 *   mails only for a row it created.
 * - `subject_type` always comes from `NOTIFICATION_KIND_META[kind].subjectType`
 *   (`notifications_kind_subject_ck`).
 * - Redaction is `WHERE redacted_at IS NULL` (redacted once, `notifications_immutable_ck`).
 */
@Injectable()
export class NotificationStore {
  async insert(trx: Transaction<DB>, row: NewNotificationRow): Promise<string | null> {
    const subjectType = NOTIFICATION_KIND_META[row.kind].subjectType;
    const inserted = await trx
      .insertInto('notifications.notifications')
      .values({
        userId: row.userId,
        app: row.app,
        kind: row.kind,
        payload: JSON.stringify(row.payload),
        subjectType,
        subjectId: subjectType === null ? null : row.subjectId,
        sourceEventId: row.sourceEventId,
      })
      .onConflict((oc) => oc.columns(['userId', 'kind', 'sourceEventId']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return inserted?.id ?? null;
  }

  /** Unread rows of one inbox, counted up to `cap` (the partial unread index, LIMIT cap). */
  async countUnread(
    trx: Transaction<DB>,
    userId: string,
    app: NotificationApp,
    cap: number,
  ): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM notifications.notifications
         WHERE user_id = ${userId} AND app = ${app} AND read_at IS NULL
         LIMIT ${cap}::int) s
    `.execute(trx);
    return rows[0]?.n ?? 0;
  }

  /** The row ids of one fan-out batch (`insertAnnouncementNotifications` returns user ids only). */
  async idsFor(
    trx: Transaction<DB>,
    userIds: readonly string[],
    kind: NotificationKind,
    sourceEventId: string,
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await trx
      .selectFrom('notifications.notifications')
      .select(['id', 'userId'])
      .where('userId', 'in', [...userIds])
      .where('kind', '=', kind)
      .where('sourceEventId', '=', sourceEventId)
      .execute();
    return new Map(rows.map((r) => [r.userId, r.id]));
  }

  /**
   * Redacts every not-yet-redacted row about these subjects (moderation hid or the author
   * deleted the subject): the kind's texts become null and `redacted: true`, `redacted_at` =
   * now(). Non-redactable kinds (certificates, media, moderation notices) are left alone.
   */
  async redactSubjects(
    trx: Transaction<DB>,
    subjectType: NotificationSubjectType,
    subjectIds: readonly string[],
  ): Promise<RedactedNotification[]> {
    if (subjectIds.length === 0) return [];
    const patch = sql.join(
      REDACTABLE_KINDS.map(
        (kind) =>
          sql`WHEN ${kind} THEN ${JSON.stringify({ ...REDACTION_PATCHES[kind], redacted: true })}::jsonb`,
      ),
      sql` `,
    );
    const { rows } = await sql<RedactedNotification>`
      UPDATE notifications.notifications
         SET payload = payload || CASE kind ${patch} END,
             redacted_at = now()
       WHERE subject_type = ${subjectType}
         AND subject_id = ANY(${[...subjectIds]}::uuid[])
         AND redacted_at IS NULL
         AND kind = ANY(${REDACTABLE_KINDS}::text[])
      RETURNING id, user_id, app
    `.execute(trx);
    return rows;
  }
}
