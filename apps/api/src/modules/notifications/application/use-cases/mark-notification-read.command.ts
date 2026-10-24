import { Injectable } from '@nestjs/common';
import { NotificationNotFound } from '../../domain/notifications.errors';
import { type InboxOwner, NotificationRepository } from '../ports/notification.repository';
import { UnreadCountPublisher } from '../unread-count.publisher';

export interface MarkNotificationReadInput {
  readonly owner: InboxOwner;
  readonly notificationId: string;
}

/**
 * `MarkRead` (design §5): sets `read_at` once; repeating it is a no-op (idempotent). After a
 * change, pushes the new unread count to the user's sockets.
 *
 * Errors: 404 `notification_not_found` (unknown, or not in the caller's inbox).
 */
@Injectable()
export class MarkNotificationReadCommand {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly unread: UnreadCountPublisher,
  ) {}

  async execute(input: MarkNotificationReadInput): Promise<void> {
    const outcome = await this.notifications.markRead(input.owner, input.notificationId);
    if (outcome === 'not_found') throw new NotificationNotFound();
    if (outcome === 'marked') await this.unread.publish(input.owner);
  }
}
