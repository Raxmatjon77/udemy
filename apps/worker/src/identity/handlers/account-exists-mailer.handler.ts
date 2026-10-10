import {
  type EventEnvelope,
  IDENTITY_USER_AGGREGATE,
  SignupAttemptedForExistingEmail,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { accountExistsMail } from '../mail/identity-mail.templates';
import { IdentityLinks } from '../mail/identity-links';

/**
 * `SignupAttemptedForExistingEmail`: "you already have an account" (at most one per 24 h per
 * user, limited by the api). Sent to the address from the event, which is the account's.
 */
@EventHandler(IDENTITY_USER_AGGREGATE, SignupAttemptedForExistingEmail.type, {
  consumerName: 'identity.account-exists-mailer',
})
export class AccountExistsMailerHandler implements EventHandlerContract {
  constructor(
    private readonly mailer: Mailer,
    private readonly links: IdentityLinks,
  ) {}

  async handle(envelope: EventEnvelope, _trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(SignupAttemptedForExistingEmail, envelope);
    await this.mailer.send({
      to: event.email,
      ...accountExistsMail({
        displayName: event.displayName,
        loginUrl: this.links.login(),
        forgotPasswordUrl: this.links.forgotPassword(),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
