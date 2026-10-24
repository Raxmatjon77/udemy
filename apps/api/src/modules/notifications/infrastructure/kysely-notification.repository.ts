import { Injectable } from '@nestjs/common';
import { sql } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type InboxOwner,
  type InboxPageQuery,
  type MarkReadOutcome,
  NotificationRepository,
  type NotificationRow,
} from '../application/ports/notification.repository';

/** `created_at` as exact UTC text with microseconds (the keyset value, P2 design §14). */
function exactUtcText(columnRef: string) {
  return sql<string>`to_char(${sql.ref(columnRef)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * The inbox through Kysely (schema doc §1 `notifications.notifications`, §8). Every statement
 * filters on `user_id` AND `app`, so it is served by `notifications_user_id_app_created_at_id_idx`
 * or, for unread rows, the partial `…_unread_idx`; and a foreign id is indistinguishable from an
 * unknown one. `read_at` is only ever set from NULL to `now()` (the immutability trigger allows
 * nothing else).
 */
@Injectable()
export class KyselyNotificationRepository extends NotificationRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async listPage(owner: InboxOwner, query: InboxPageQuery): Promise<NotificationRow[]> {
    let select = this.db
      .selectFrom('notifications.notifications as n')
      .select([
        'n.id',
        'n.app',
        'n.kind',
        'n.payload',
        'n.subjectType',
        'n.subjectId',
        'n.createdAt',
        'n.readAt',
      ])
      .select(exactUtcText('n.created_at').as('createdAtKey'))
      .where('n.userId', '=', owner.userId)
      .where('n.app', '=', owner.app);
    if (query.unreadOnly) select = select.where('n.readAt', 'is', null);
    if (query.after !== null) {
      select = select.where(
        sql<boolean>`(n.created_at, n.id) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy('n.createdAt', 'desc')
      .orderBy('n.id', 'desc')
      .limit(query.limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      app: row.app,
      kind: row.kind,
      payload: row.payload,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      createdAt: row.createdAt,
      readAt: row.readAt,
      keyset: { createdAt: row.createdAtKey, id: row.id },
    }));
  }

  async countUnread(owner: InboxOwner, cap: number): Promise<number> {
    const unread = this.db
      .selectFrom('notifications.notifications')
      .select('id')
      .where('userId', '=', owner.userId)
      .where('app', '=', owner.app)
      .where('readAt', 'is', null)
      .limit(cap)
      .as('unread');
    const row = await this.db
      .selectFrom(unread)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async markRead(owner: InboxOwner, notificationId: string): Promise<MarkReadOutcome> {
    const marked = await this.db
      .updateTable('notifications.notifications')
      .set({ readAt: sql<Date>`now()` })
      .where('id', '=', notificationId)
      .where('userId', '=', owner.userId)
      .where('app', '=', owner.app)
      .where('readAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (marked !== undefined) return 'marked';
    const existing = await this.db
      .selectFrom('notifications.notifications')
      .select('id')
      .where('id', '=', notificationId)
      .where('userId', '=', owner.userId)
      .where('app', '=', owner.app)
      .executeTakeFirst();
    return existing === undefined ? 'not_found' : 'already_read';
  }

  async markReadUpTo(owner: InboxOwner, upToId: string): Promise<number | null> {
    // One statement: the anchor's exact (created_at, id) never leaves SQL (no precision loss),
    // and the unread partial index serves the range update.
    const result = await sql<{ found: boolean; marked: string }>`
      WITH anchor AS (
        SELECT created_at, id
          FROM notifications.notifications
         WHERE id = ${upToId}::uuid AND user_id = ${owner.userId}::uuid AND app = ${owner.app}
      ), marked AS (
        UPDATE notifications.notifications n
           SET read_at = now()
          FROM anchor a
         WHERE n.user_id = ${owner.userId}::uuid
           AND n.app = ${owner.app}
           AND n.read_at IS NULL
           AND (n.created_at, n.id) <= (a.created_at, a.id)
        RETURNING n.id
      )
      SELECT EXISTS (SELECT 1 FROM anchor) AS found, (SELECT count(*) FROM marked) AS marked
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined || !row.found) return null;
    return Number(row.marked);
  }
}
