import { Logger } from '@nestjs/common';
import {
  type EventEnvelope,
  InstructorApplicationApproved,
  InstructorApplicationRejected,
  USERS_INSTRUCTOR_APPLICATION_AGGREGATE,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { UsersLinks } from '../mail/users-links';
import {
  instructorApplicationApprovedMail,
  instructorApplicationRejectedMail,
} from '../mail/users-mail.templates';

/*
 * Consumers of the `users.instructor_application` topic (design §7):
 * - InstructorApplicationApproved / Rejected: mail the applicant (below).
 * - InstructorApplicationSubmitted: the optional admin digest mail is DEFERRED (not in Phase 1);
 *   no handler, so the dispatcher skips the event.
 * - InstructorApplicationWithdrawn: no mail by design.
 * The recipient is always read from identity.users at handling time (current email and name).
 */

/** `InstructorApplicationApproved`: "you're now an instructor" with a link to the instructor app. */
@EventHandler(USERS_INSTRUCTOR_APPLICATION_AGGREGATE, InstructorApplicationApproved.type, {
  consumerName: 'users.application-approved-mailer',
})
export class ApplicationApprovedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(ApplicationApprovedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: UsersLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(InstructorApplicationApproved, envelope);
    const contact = await this.contacts.find(trx, event.applicantId);
    if (contact === null) {
      this.logger.warn(
        { applicationId: event.applicationId, applicantId: event.applicantId },
        'InstructorApplicationApproved for an unknown user; no mail',
      );
      return;
    }
    await this.mailer.send({
      to: contact.email,
      ...instructorApplicationApprovedMail({
        displayName: contact.displayName,
        instructorLoginUrl: this.links.instructorLogin(),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}

/** `InstructorApplicationRejected`: the admin's reason and a link to apply again. */
@EventHandler(USERS_INSTRUCTOR_APPLICATION_AGGREGATE, InstructorApplicationRejected.type, {
  consumerName: 'users.application-rejected-mailer',
})
export class ApplicationRejectedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(ApplicationRejectedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: UsersLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(InstructorApplicationRejected, envelope);
    const contact = await this.contacts.find(trx, event.applicantId);
    if (contact === null) {
      this.logger.warn(
        { applicationId: event.applicationId, applicantId: event.applicantId },
        'InstructorApplicationRejected for an unknown user; no mail',
      );
      return;
    }
    await this.mailer.send({
      to: contact.email,
      ...instructorApplicationRejectedMail({
        displayName: contact.displayName,
        reason: event.reason,
        becomeInstructorUrl: this.links.becomeInstructor(),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
