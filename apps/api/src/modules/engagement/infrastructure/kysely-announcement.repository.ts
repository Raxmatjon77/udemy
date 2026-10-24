import { Injectable } from '@nestjs/common';
import { ANNOUNCEMENT_LIMITS } from '@udemy/contracts';
import { type DB, lockAnnouncementQuota, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { AnnouncementRepository } from '../application/ports/announcement.repository';
import type { CreatedAtKeyset, CreatedAtRow } from '../application/ports/qa.repository';
import type { AnnouncementRecord } from '../domain/announcement';
import { mapEngagementConstraints } from './engagement-constraint-errors';
import { ANNOUNCEMENT_COLUMNS, type AnnouncementRow, toAnnouncementRecord } from './qa-row-mapping';

const WINDOW_DAYS = ANNOUNCEMENT_LIMITS.windowDays;

/**
 * `engagement.announcements` (D18). The quota lock and count are `@udemy/db`
 * `lockAnnouncementQuota` (the `anno` two-int advisory lock, R12); the window rows use the
 * same predicate (`created_at > now() - 30 days`, deleted rows included) so `retryAt` and the
 * count always agree. Both reads are served by `announcements_course_id_created_at_id_idx`.
 */
@Injectable()
export class KyselyAnnouncementRepository extends AnnouncementRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async listLive(
    courseId: string,
    after: CreatedAtKeyset | null,
    limit: number,
  ): Promise<CreatedAtRow<AnnouncementRecord>[]> {
    const keyset =
      after === null
        ? sql``
        : sql`AND (created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
    const { rows } = await sql<AnnouncementRow & { createdAtKey: string }>`
      SELECT ${ANNOUNCEMENT_COLUMNS},
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
        FROM engagement.announcements
       WHERE course_id = ${courseId} AND deleted_at IS NULL ${keyset}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}::int
    `.execute(this.db);
    return rows.map(({ createdAtKey, ...row }) => ({
      record: toAnnouncementRecord(row),
      createdAtKey,
    }));
  }

  async windowCreatedAts(courseId: string, trx?: Transaction<DB>): Promise<Date[]> {
    const { rows } = await sql<{ createdAt: Date }>`
      SELECT created_at FROM engagement.announcements
       WHERE course_id = ${courseId}
         AND created_at > now() - make_interval(days => ${WINDOW_DAYS}::int)
       ORDER BY created_at
    `.execute(trx ?? this.db);
    return rows.map((r) => r.createdAt);
  }

  async lockQuota(trx: Transaction<DB>, courseId: string): Promise<number> {
    const { postedInWindow } = await lockAnnouncementQuota(trx, courseId, {
      windowDays: WINDOW_DAYS,
    });
    return postedInWindow;
  }

  async insert(
    trx: Transaction<DB>,
    input: {
      courseId: string;
      authorId: string;
      title: string;
      bodyMd: string;
      sendEmail: boolean;
    },
  ): Promise<AnnouncementRecord> {
    const { rows } = await mapEngagementConstraints(() =>
      sql<AnnouncementRow>`
        INSERT INTO engagement.announcements (course_id, author_id, title, body_md, send_email)
        VALUES (${input.courseId}, ${input.authorId}, ${input.title}, ${input.bodyMd}, ${input.sendEmail})
        RETURNING ${ANNOUNCEMENT_COLUMNS}
      `.execute(trx),
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT … RETURNING returned no announcement');
    return toAnnouncementRecord(row);
  }

  async softDelete(
    trx: Transaction<DB>,
    courseId: string,
    announcementId: string,
    actorId: string,
  ): Promise<{ readonly announcement: AnnouncementRecord; readonly deletedAt: Date } | null> {
    const { rows } = await mapEngagementConstraints(() =>
      sql<AnnouncementRow & { deletedAt: Date }>`
        UPDATE engagement.announcements SET deleted_at = now(), deleted_by = ${actorId}
         WHERE id = ${announcementId} AND course_id = ${courseId} AND deleted_at IS NULL
        RETURNING ${ANNOUNCEMENT_COLUMNS}, deleted_at
      `.execute(trx),
    );
    const row = rows[0];
    if (row === undefined) return null;
    const { deletedAt, ...announcement } = row;
    return { announcement: toAnnouncementRecord(announcement), deletedAt };
  }
}
