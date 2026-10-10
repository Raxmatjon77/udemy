import { Logger } from '@nestjs/common';
import {
  type EventEnvelope,
  IDENTITY_USER_AGGREGATE,
  UserBanned,
  UserUnbanned,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { userBannedMail, userUnbannedMail } from '../mail/identity-mail.templates';
import { IdentityLinks } from '../mail/identity-links';

/**
 * `UserBanned`: suspension notice with the admin's reason and a support contact, sent to the
 * account's current address. Kafka key = userId, so a later `UserUnbanned` mail always follows.
 */
@EventHandler(IDENTITY_USER_AGGREGATE, UserBanned.type, {
  consumerName: 'identity.ban-notice-mailer',
})
export class UserBannedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(UserBannedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: IdentityLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(UserBanned, envelope);
    const contact = await this.contacts.find(trx, event.userId);
    if (contact === null) {
      this.logger.warn({ userId: event.userId }, 'UserBanned for an unknown user; no mail');
      return;
    }
    await this.mailer.send({
      to: contact.email,
      ...userBannedMail({
        displayName: contact.displayName,
        reason: event.reason,
        bannedAt: new Date(event.bannedAt),
        supportEmail: this.links.supportEmail(),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}

/** `UserUnbanned`: "access restored" notice with a sign-in link. */
@EventHandler(IDENTITY_USER_AGGREGATE, UserUnbanned.type, {
  consumerName: 'identity.unban-notice-mailer',
})
export class UserUnbannedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(UserUnbannedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: IdentityLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(UserUnbanned, envelope);
    const contact = await this.contacts.find(trx, event.userId);
    if (contact === null) {
      this.logger.warn({ userId: event.userId }, 'UserUnbanned for an unknown user; no mail');
      return;
    }
    await this.mailer.send({
      to: contact.email,
      ...userUnbannedMail({
        displayName: contact.displayName,
        liftedAt: new Date(event.liftedAt),
        loginUrl: this.links.login(),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
