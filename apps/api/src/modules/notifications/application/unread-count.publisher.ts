import { Injectable, Logger } from '@nestjs/common';
import { realtimeUserRoom, UNREAD_COUNT_CAP } from '@udemy/contracts';
import { RealtimeEmitter } from '../../../shared/realtime';
import { type InboxOwner, NotificationRepository } from './ports/notification.repository';

/**
 * Pushes `notification.unread {count}` to the owner's user room after a mark-read committed
 * (design §7 realtime events), so the bells of the user's other tabs and devices update.
 *
 * Best effort: a hint lost to a Redis or DB blip is harmless (clients refetch on reconnect and
 * on focus), so this never fails the request; it logs and moves on.
 */
@Injectable()
export class UnreadCountPublisher {
  private readonly logger = new Logger(UnreadCountPublisher.name);

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly emitter: RealtimeEmitter,
  ) {}

  async publish(owner: InboxOwner): Promise<void> {
    try {
      const count = await this.notifications.countUnread(owner, UNREAD_COUNT_CAP);
      await this.emitter.emit(realtimeUserRoom(owner.userId, owner.app), 'notification.unread', {
        count,
      });
    } catch (error) {
      this.logger.warn({ err: error, userId: owner.userId }, 'Could not push the unread count');
    }
  }
}
