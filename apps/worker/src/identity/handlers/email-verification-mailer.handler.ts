import {
  EmailVerificationRequested,
  type EventEnvelope,
  IDENTITY_USER_AGGREGATE,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { emailVerificationMail } from '../mail/identity-mail.templates';
import { IdentityLinks } from '../mail/identity-links';
import { IssueOneTimeToken } from '../one-time-tokens/issue-one-time-token';

/**
 * `EmailVerificationRequested` (SIGNUP or RESEND): IssueOneTimeToken, then the verification
 * mail (the SIGNUP variant doubles as the welcome mail). Both happen inside the transaction
 * that claims the event: a redelivery after "mail sent, commit failed" re-issues the SAME
 * token and re-sends the same link with the same Message-ID (D10, §7).
 */
@EventHandler(IDENTITY_USER_AGGREGATE, EmailVerificationRequested.type, {
  consumerName: 'identity.email-verification-mailer',
})
export class EmailVerificationMailerHandler implements EventHandlerContract {
  constructor(
    private readonly issueToken: IssueOneTimeToken,
    private readonly mailer: Mailer,
    private readonly links: IdentityLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(EmailVerificationRequested, envelope);
    const issued = await this.issueToken.execute(trx, {
      eventId: envelope.eventId,
      userId: event.userId,
      purpose: 'EMAIL_VERIFICATION',
      email: event.email,
      requestedAt: new Date(event.requestedAt),
    });
    if (issued.kind === 'skipped') return;

    await this.mailer.send({
      to: event.email,
      ...emailVerificationMail({
        displayName: event.displayName,
        reason: event.reason,
        link: this.links.verifyEmail(issued.rawToken),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
