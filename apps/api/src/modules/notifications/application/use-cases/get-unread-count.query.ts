import { Injectable } from '@nestjs/common';
import { UNREAD_COUNT_CAP, type UnreadCount } from '@udemy/contracts';
import { type InboxOwner, NotificationRepository } from '../ports/notification.repository';

/**
 * `UnreadCount` (design §5): `count(*)` over the partial unread index with `LIMIT 100`, so the
 * cost is bounded whatever the backlog; 100 comes back as `capped` ("99+").
 */
@Injectable()
export class GetUnreadCountQuery {
  constructor(private readonly notifications: NotificationRepository) {}

  async execute(owner: InboxOwner): Promise<UnreadCount> {
    const count = Math.min(
      UNREAD_COUNT_CAP,
      await this.notifications.countUnread(owner, UNREAD_COUNT_CAP),
    );
    return { count, capped: count >= UNREAD_COUNT_CAP };
  }
}
