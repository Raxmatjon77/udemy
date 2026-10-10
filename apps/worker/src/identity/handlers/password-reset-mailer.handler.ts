import {
  type EventEnvelope,
  IDENTITY_USER_AGGREGATE,
  PasswordResetRequested,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { passwordResetMail } from '../mail/identity-mail.templates';
import { IdentityLinks } from '../mail/identity-links';
import { IssueOneTimeToken } from '../one-time-tokens/issue-one-time-token';

/** `PasswordResetRequested`: IssueOneTimeToken (30 min), then the reset mail (see D10, §7). */
@EventHandler(IDENTITY_USER_AGGREGATE, PasswordResetRequested.type, {
  consumerName: 'identity.password-reset-mailer',
})
export class PasswordResetMailerHandler implements EventHandlerContract {
  constructor(
    private readonly issueToken: IssueOneTimeToken,
    private readonly mailer: Mailer,
    private readonly links: IdentityLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(PasswordResetRequested, envelope);
    const issued = await this.issueToken.execute(trx, {
      eventId: envelope.eventId,
      userId: event.userId,
      purpose: 'PASSWORD_RESET',
      email: event.email,
      requestedAt: new Date(event.requestedAt),
    });
    if (issued.kind === 'skipped') return;

    await this.mailer.send({
      to: event.email,
      ...passwordResetMail({
        displayName: event.displayName,
        link: this.links.resetPassword(issued.rawToken),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
