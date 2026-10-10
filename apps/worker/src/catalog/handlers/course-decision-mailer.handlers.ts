import { Logger } from '@nestjs/common';
import {
  CATALOG_COURSE_AGGREGATE,
  CoursePublished,
  CourseRejected,
  type EventEnvelope,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { CatalogLinks } from '../mail/catalog-links';
import { coursePublishedMail, courseRejectedMail } from '../mail/catalog-mail.templates';
import { CourseTitleReader } from '../persistence/course-title.reader';

/*
 * The course-decision mailer of design §7 (`catalog.course-decision-mailer`), as one handler per
 * event type: the registry needs a distinct consumer name per handler, so they are pinned as
 * `catalog.course-published-mailer` and `catalog.course-rejected-mailer`. The instructor's
 * current address and the reviewed revision's title are read at handling time.
 */

/** `CoursePublished` (INITIAL or UPDATE): "your course is live" with builder + public links. */
@EventHandler(CATALOG_COURSE_AGGREGATE, CoursePublished.type, {
  consumerName: 'catalog.course-published-mailer',
})
export class CoursePublishedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(CoursePublishedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly titles: CourseTitleReader,
    private readonly mailer: Mailer,
    private readonly links: CatalogLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(CoursePublished, envelope);
    const owner = await this.contacts.find(trx, event.ownerId);
    if (owner === null) {
      this.logger.warn(
        { courseId: event.courseId, ownerId: event.ownerId },
        'CoursePublished for an unknown owner; no mail',
      );
      return;
    }
    await this.mailer.send({
      to: owner.email,
      ...coursePublishedMail({
        displayName: owner.displayName,
        courseTitle: await this.titles.ofRevision(trx, event.courseId, event.revisionId),
        kind: event.kind,
        builderUrl: this.links.courseBuilder(event.courseId),
        publicUrl: this.links.publicCourse(event.slug),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}

/** `CourseRejected` (INITIAL or UPDATE): the admin's reason and the builder link. */
@EventHandler(CATALOG_COURSE_AGGREGATE, CourseRejected.type, {
  consumerName: 'catalog.course-rejected-mailer',
})
export class CourseRejectedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(CourseRejectedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly titles: CourseTitleReader,
    private readonly mailer: Mailer,
    private readonly links: CatalogLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(CourseRejected, envelope);
    const owner = await this.contacts.find(trx, event.ownerId);
    if (owner === null) {
      this.logger.warn(
        { courseId: event.courseId, ownerId: event.ownerId },
        'CourseRejected for an unknown owner; no mail',
      );
      return;
    }
    await this.mailer.send({
      to: owner.email,
      ...courseRejectedMail({
        displayName: owner.displayName,
        courseTitle: await this.titles.ofRevision(trx, event.courseId, event.revisionId),
        kind: event.kind,
        reason: event.reason,
        builderUrl: this.links.courseBuilder(event.courseId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
