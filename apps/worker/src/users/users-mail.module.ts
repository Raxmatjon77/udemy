import { Module } from '@nestjs/common';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import {
  ApplicationApprovedMailerHandler,
  ApplicationRejectedMailerHandler,
} from './handlers/application-decision-mailer.handlers';
import { UsersLinks } from './mail/users-links';

/**
 * Consumers of the `users.instructor_application` topic that send email (design §7). Relies on
 * the global MailModule (Mailer) and WorkerConfigModule. The @EventHandler providers are
 * discovered by the messaging registry (which also ensures the topic and its `.dlq` at
 * startup); nothing is exported.
 */
@Module({
  providers: [
    UsersLinks,
    UserContactReader,
    ApplicationApprovedMailerHandler,
    ApplicationRejectedMailerHandler,
  ],
})
export class UsersMailModule {}
