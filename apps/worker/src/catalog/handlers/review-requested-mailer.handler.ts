import { Logger } from '@nestjs/common';
import {
  CATALOG_COURSE_AGGREGATE,
  CourseSubmittedForReview,
  type EventEnvelope,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { CatalogLinks } from '../mail/catalog-links';
import { reviewRequestedMail } from '../mail/catalog-mail.templates';
import { AdminRecipientsReader } from '../persistence/admin-recipients.reader';

/**
 * `CourseSubmittedForReview` -> a "review requested" mail to every ADMIN (design §7), linking to
 * `${ADMIN_APP_ORIGIN}/course-reviews/{revisionId}`.
 *
 * One message per admin (admins never see each other's addresses). Each message's Message-ID is
 * derived from the event id plus the recipient (`<eventId.adminId@udemy.local>`), so it is stable
 * across redeliveries. If a send fails midway, the whole handler is retried and earlier admins
 * get the same message again with the same Message-ID (at-least-once, deduplicable).
 */
@EventHandler(CATALOG_COURSE_AGGREGATE, CourseSubmittedForReview.type, {
  consumerName: 'catalog.review-requested-mailer',
})
export class ReviewRequestedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(ReviewRequestedMailerHandler.name);

  constructor(
    private readonly admins: AdminRecipientsReader,
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: CatalogLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(CourseSubmittedForReview, envelope);
    const recipients = await this.admins.list(trx);
    if (recipients.length === 0) {
      this.logger.warn(
        { courseId: event.courseId, revisionId: event.revisionId },
        'CourseSubmittedForReview but no active admin exists; no mail',
      );
      return;
    }
    const owner = await this.contacts.find(trx, event.ownerId);
    const reviewUrl = this.links.courseReview(event.revisionId);
    for (const admin of recipients) {
      await this.mailer.send({
        to: admin.email,
        ...reviewRequestedMail({
          adminName: admin.displayName,
          ownerName: owner?.displayName ?? null,
          courseTitle: event.title,
          kind: event.kind,
          revisionNo: event.revisionNo,
          submittedAt: new Date(event.submittedAt),
          reviewUrl,
        }),
        messageId: eventMessageId(`${envelope.eventId}.${admin.userId}`),
      });
    }
  }
}
