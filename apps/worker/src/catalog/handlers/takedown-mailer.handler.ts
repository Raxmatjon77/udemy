import { Logger } from '@nestjs/common';
import { CATALOG_COURSE_AGGREGATE, CourseArchived, type EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { CatalogLinks } from '../mail/catalog-links';
import { courseTakedownMail } from '../mail/catalog-mail.templates';
import { CourseTitleReader } from '../persistence/course-title.reader';

/**
 * `CourseArchived` with `byAdmin` (a takedown) -> mail the instructor the admin's reason
 * (design §7). An owner's own archive sends nothing (the event is still claimed as processed).
 */
@EventHandler(CATALOG_COURSE_AGGREGATE, CourseArchived.type, {
  consumerName: 'catalog.takedown-mailer',
})
export class TakedownMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(TakedownMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly titles: CourseTitleReader,
    private readonly mailer: Mailer,
    private readonly links: CatalogLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(CourseArchived, envelope);
    // The contract guarantees a reason (>= 10 chars) whenever byAdmin is true.
    if (!event.byAdmin || event.reason === null) return;
    const owner = await this.contacts.find(trx, event.ownerId);
    if (owner === null) {
      this.logger.warn(
        { courseId: event.courseId, ownerId: event.ownerId },
        'CourseArchived (takedown) for an unknown owner; no mail',
      );
      return;
    }
    await this.mailer.send({
      to: owner.email,
      ...courseTakedownMail({
        displayName: owner.displayName,
        courseTitle: await this.titles.live(trx, event.courseId),
        reason: event.reason,
        builderUrl: this.links.courseBuilder(event.courseId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
