import { Module } from '@nestjs/common';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import {
  CoursePublishedMailerHandler,
  CourseRejectedMailerHandler,
} from './handlers/course-decision-mailer.handlers';
import { ReviewRequestedMailerHandler } from './handlers/review-requested-mailer.handler';
import { TakedownMailerHandler } from './handlers/takedown-mailer.handler';
import { CatalogLinks } from './mail/catalog-links';
import { AdminRecipientsReader } from './persistence/admin-recipients.reader';
import { CourseTitleReader } from './persistence/course-title.reader';

/**
 * Consumers of the `catalog.course` topic that send email (design §7): review requested (to
 * admins), published / rejected (to the instructor) and admin takedown (to the instructor).
 * Other course events have no Phase 2 consumer. Relies on the global MailModule and
 * WorkerConfigModule; the registry ensures `catalog.course` and `catalog.course.dlq` at startup.
 */
@Module({
  providers: [
    CatalogLinks,
    UserContactReader,
    AdminRecipientsReader,
    CourseTitleReader,
    ReviewRequestedMailerHandler,
    CoursePublishedMailerHandler,
    CourseRejectedMailerHandler,
    TakedownMailerHandler,
  ],
})
export class CatalogMailModule {}
