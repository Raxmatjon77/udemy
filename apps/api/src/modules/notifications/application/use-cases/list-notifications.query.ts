import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_KIND_META,
  type Notification,
  type NotificationKind,
  type NotificationPage,
  NotificationSchema,
} from '@udemy/contracts';
import { decodeNotificationCursor, encodeNotificationCursor } from '../notification-cursor';
import {
  type InboxOwner,
  NotificationRepository,
  type NotificationRow,
} from '../ports/notification.repository';

export interface ListNotificationsInput {
  readonly owner: InboxOwner;
  readonly unreadOnly: boolean;
  readonly cursor?: string;
  /** 1–50 (the request schema enforces it). */
  readonly limit: number;
}

/**
 * `ListNotifications` (design §5 notifications): the caller's inbox for the principal's app,
 * keyset `(created_at DESC, id DESC)`, optionally unread only.
 *
 * Every row is validated against the contract (`NotificationSchema`: the payload union by
 * kind) before it is returned. A row that does not match (written by a newer worker, or a bug)
 * is left out and logged, never sent half-valid; the cursor still moves past it, so a page may
 * be shorter than `limit`.
 *
 * Errors: 422 `validation_failed` for a cursor this api did not produce.
 */
@Injectable()
export class ListNotificationsQuery {
  private readonly logger = new Logger(ListNotificationsQuery.name);

  constructor(private readonly notifications: NotificationRepository) {}

  async execute(input: ListNotificationsInput): Promise<NotificationPage> {
    const after = input.cursor === undefined ? null : decodeNotificationCursor(input.cursor);
    const rows = await this.notifications.listPage(input.owner, {
      unreadOnly: input.unreadOnly,
      after,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last !== undefined
        ? encodeNotificationCursor(last.keyset)
        : null;
    return { items: page.flatMap((row) => this.toNotification(row)), nextCursor };
  }

  private toNotification(row: NotificationRow): Notification[] {
    const meta = NOTIFICATION_KIND_META[row.kind as NotificationKind] as
      (typeof NOTIFICATION_KIND_META)[NotificationKind] | undefined;
    const parsed = NotificationSchema.safeParse({
      id: row.id,
      app: row.app,
      category: meta?.category,
      kind: row.kind,
      payload: row.payload,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    });
    if (parsed.success) return [parsed.data];
    this.logger.warn(
      { notificationId: row.id, kind: row.kind, issues: parsed.error.issues.length },
      'Skipping a notification that does not match the contract',
    );
    return [];
  }
}
