import { Module } from '@nestjs/common';
import { AccountExistsMailerHandler } from './handlers/account-exists-mailer.handler';
import {
  UserBannedMailerHandler,
  UserUnbannedMailerHandler,
} from './handlers/ban-notice-mailer.handlers';
import { EmailVerificationMailerHandler } from './handlers/email-verification-mailer.handler';
import { PasswordResetMailerHandler } from './handlers/password-reset-mailer.handler';
import {
  PasswordChangedMailerHandler,
  SessionCompromiseMailerHandler,
} from './handlers/security-notice-mailer.handlers';
import { IdentityLinks } from './mail/identity-links';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import { IssueOneTimeToken } from './one-time-tokens/issue-one-time-token';
import { KyselyOneTimeTokenStore } from './one-time-tokens/kysely-one-time-token.store';
import { OneTimeTokenStore } from './one-time-tokens/one-time-token.store';

/**
 * Consumers of the `identity.user` topic that send email (design §7). Relies on the global
 * MailModule (Mailer) and WorkerConfigModule. The @EventHandler providers are discovered by the
 * messaging registry; nothing is exported.
 */
@Module({
  providers: [
    { provide: OneTimeTokenStore, useClass: KyselyOneTimeTokenStore },
    IssueOneTimeToken,
    IdentityLinks,
    UserContactReader,
    EmailVerificationMailerHandler,
    PasswordResetMailerHandler,
    AccountExistsMailerHandler,
    PasswordChangedMailerHandler,
    SessionCompromiseMailerHandler,
    UserBannedMailerHandler,
    UserUnbannedMailerHandler,
  ],
})
export class IdentityMailModule {}
