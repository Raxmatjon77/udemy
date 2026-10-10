import { Module } from '@nestjs/common';
import { AdminRecipientsReader } from '../shared/mail/admin-recipients.reader';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import {
  AdminAlertSender,
  PaymentDisputedAlertHandler,
  PaymentMismatchAlertHandler,
  RefundFailedAlertHandler,
  RefundReviewAlertHandler,
} from './handlers/admin-alert-mailer.handlers';
import { ReceiptMailerHandler } from './handlers/receipt-mailer.handler';
import {
  RefundRejectedMailerHandler,
  RefundSucceededMailerHandler,
  RefundUnderReviewMailerHandler,
} from './handlers/refund-mailers.handlers';
import { CommerceLinks } from './mail/commerce-links';
import { CommerceMailReader } from './persistence/commerce-mail.reader';

/**
 * Consumers of the `commerce.order` topic that send email (Phase 4 design §7, D11): the
 * receipt, the three student refund mails and the admin alerts. Relies on the global MailModule
 * and WorkerConfigModule; the registry ensures `commerce.order` and `commerce.order.dlq` at
 * startup. Nothing is exported.
 */
@Module({
  providers: [
    CommerceLinks,
    UserContactReader,
    AdminRecipientsReader,
    CommerceMailReader,
    AdminAlertSender,
    ReceiptMailerHandler,
    RefundSucceededMailerHandler,
    RefundRejectedMailerHandler,
    RefundUnderReviewMailerHandler,
    PaymentMismatchAlertHandler,
    PaymentDisputedAlertHandler,
    RefundReviewAlertHandler,
    RefundFailedAlertHandler,
  ],
})
export class CommerceMailModule {}
