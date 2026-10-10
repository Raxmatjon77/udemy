import { Logger } from '@nestjs/common';
import {
  type EventEnvelope,
  IDENTITY_USER_AGGREGATE,
  PasswordChanged,
  SessionCompromiseDetected,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract } from '../../messaging';
import { passwordChangedMail, sessionCompromiseMail } from '../mail/identity-mail.templates';
import { IdentityLinks } from '../mail/identity-links';
import { UserContactReader } from '../mail/user-contact.reader';
import { parseIdentityEvent } from './parse-identity-event';

/** `PasswordChanged` (RESET or CHANGE): security notice to the account's current address. */
@EventHandler(IDENTITY_USER_AGGREGATE, PasswordChanged.type, {
  consumerName: 'identity.password-changed-mailer',
})
export class PasswordChangedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(PasswordChangedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: IdentityLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseIdentityEvent(PasswordChanged, envelope);
    const contact = await this.contacts.find(trx, event.userId);
    if (contact === null) {
      this.logger.warn({ userId: event.userId }, 'PasswordChanged for an unknown user; no mail');
      return;
    }
    await this.mailer.send({
      to: contact.email,
      ...passwordChangedMail({
        displayName: contact.displayName,
        via: event.via,
        changedAt: new Date(event.changedAt),
        forgotPasswordUrl: this.links.forgotPassword(),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}

/** `SessionCompromiseDetected` (refresh-token reuse): security notice. */
@EventHandler(IDENTITY_USER_AGGREGATE, SessionCompromiseDetected.type, {
  consumerName: 'identity.session-compromise-mailer',
})
export class SessionCompromiseMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(SessionCompromiseMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: IdentityLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseIdentityEvent(SessionCompromiseDetected, envelope);
    const contact = await this.contacts.find(trx, event.userId);
    if (contact === null) {
      this.logger.warn({ userId: event.userId }, 'SessionCompromiseDetected for an unknown user');
      return;
    }
    await this.mailer.send({
      to: contact.email,
      ...sessionCompromiseMail({
        displayName: contact.displayName,
        clientApp: event.clientApp,
        detectedAt: new Date(event.detectedAt),
        forgotPasswordUrl: this.links.forgotPassword(),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
