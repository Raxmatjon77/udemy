import { Injectable } from '@nestjs/common';
import { AnnouncementDeleted } from '@udemy/contracts';
import { AnnouncementNotFound } from '../../domain/engagement.errors';
import { AnnouncementRepository } from '../ports/announcement.repository';
import { EngagementEventPublisher } from '../ports/engagement-event.publisher';
import { TransactionRunner } from '../ports/transaction-runner';

export interface DeleteAnnouncementInput {
  /** The course owner (`@CheckPolicy({ resource: 'course', action: 'engage' })`). */
  readonly actorId: string;
  readonly courseId: string;
  readonly announcementId: string;
}

/**
 * `DeleteAnnouncement` (design §5, D18, schema open point 2: announcements are delete-only,
 * no moderation flow). A soft delete of an announcement of THIS course (IDOR) with
 * `AnnouncementDeleted` (the worker redacts its notifications). The quota is not refunded.
 *
 * Errors: 404 `announcement_not_found` (unknown, another course's, or already deleted).
 */
@Injectable()
export class DeleteAnnouncementCommand {
  constructor(
    private readonly announcements: AnnouncementRepository,
    private readonly events: EngagementEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: DeleteAnnouncementInput): Promise<void> {
    await this.tx.run(async (trx) => {
      const deleted = await this.announcements.softDelete(
        trx,
        input.courseId,
        input.announcementId,
        input.actorId,
      );
      if (deleted === null) throw new AnnouncementNotFound();
      const a = deleted.announcement;
      await this.events.publish(trx, AnnouncementDeleted, {
        announcementId: a.id,
        courseId: a.courseId,
        authorId: a.authorId,
        sendEmail: a.sendEmail,
        actorId: input.actorId,
        deletedAt: deleted.deletedAt.toISOString(),
      });
    });
  }
}
