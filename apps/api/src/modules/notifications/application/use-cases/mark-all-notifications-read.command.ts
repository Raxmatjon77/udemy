import { Injectable } from '@nestjs/common';
import { NotificationNotFound } from '../../domain/notifications.errors';
import { type InboxOwner, NotificationRepository } from '../ports/notification.repository';
import { UnreadCountPublisher } from '../unread-count.publisher';

export interface MarkAllNotificationsReadInput {
  readonly owner: InboxOwner;
  /** The newest notification the client has seen: it and everything older become read. */
  readonly upToId: string;
}

/**
 * `MarkAllRead {upToId}` (design §5): marks every unread row at or before `upToId` in keyset
 * order. Rows that arrived after the client loaded its list stay unread, so "mark all read"
 * never swallows a notification the user has not seen. Idempotent.
 *
 * Errors: 404 `notification_not_found` (`upToId` is not in the caller's inbox).
 */
@Injectable()
export class MarkAllNotificationsReadCommand {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly unread: UnreadCountPublisher,
  ) {}

  async execute(input: MarkAllNotificationsReadInput): Promise<void> {
    const marked = await this.notifications.markReadUpTo(input.owner, input.upToId);
    if (marked === null) throw new NotificationNotFound();
    if (marked > 0) await this.unread.publish(input.owner);
  }
}
