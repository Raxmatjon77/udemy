import { Logger } from '@nestjs/common';
import {
  COMMERCE_ORDER_AGGREGATE,
  type EventEnvelope,
  RefundRejected,
  RefundRequested,
  RefundSucceeded,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { CommerceLinks } from '../mail/commerce-links';
import {
  refundRejectedMail,
  refundSucceededMail,
  refundUnderReviewMail,
} from '../mail/commerce-mail.templates';
import { CommerceMailReader } from '../persistence/commerce-mail.reader';

/*
 * The student-facing refund mails of Phase 4 design §7 / D11, one handler per event type
 * (pinned consumer names). The refund events carry ids and amounts only: the course title
 * (order_lines snapshot) and the order number are read in the handler's transaction, with a
 * neutral fallback when the row is gone. Every mail links to the order page with the refund
 * timeline (`${STUDENT_APP_ORIGIN}/account/orders/{orderId}`).
 */

/** `RefundSucceeded`: the money is on its way back. */
@EventHandler(COMMERCE_ORDER_AGGREGATE, RefundSucceeded.type, {
  consumerName: 'commerce.refund-mailer',
})
export class RefundSucceededMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(RefundSucceededMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly commerce: CommerceMailReader,
    private readonly mailer: Mailer,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(RefundSucceeded, envelope);
    const student = await this.contacts.find(trx, event.userId);
    if (student === null) {
      this.logger.warn(
        { refundId: event.refundId, userId: event.userId },
        'RefundSucceeded for an unknown user; no mail',
      );
      return;
    }
    const refund = await this.commerce.refund(trx, event.refundId);
    await this.mailer.send({
      to: student.email,
      ...refundSucceededMail({
        displayName: student.displayName,
        courseTitle: refund?.courseTitle ?? null,
        orderNumber: refund?.orderNumber ?? null,
        amount: event.amount,
        currency: event.currency,
        succeededAt: new Date(event.succeededAt),
        orderUrl: this.links.order(event.orderId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}

/** `RefundRejected`: the admin's reason; the student keeps access. */
@EventHandler(COMMERCE_ORDER_AGGREGATE, RefundRejected.type, {
  consumerName: 'commerce.refund-rejected-mailer',
})
export class RefundRejectedMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(RefundRejectedMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly commerce: CommerceMailReader,
    private readonly mailer: Mailer,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(RefundRejected, envelope);
    const student = await this.contacts.find(trx, event.userId);
    if (student === null) {
      this.logger.warn(
        { refundId: event.refundId, userId: event.userId },
        'RefundRejected for an unknown user; no mail',
      );
      return;
    }
    const refund = await this.commerce.refund(trx, event.refundId);
    await this.mailer.send({
      to: student.email,
      ...refundRejectedMail({
        displayName: student.displayName,
        courseTitle: refund?.courseTitle ?? null,
        orderNumber: refund?.orderNumber ?? null,
        reason: event.reason,
        orderUrl: this.links.order(event.orderId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}

/** `RefundRequested` (NEEDS_REVIEW only; auto-approved refunds emit RefundApproved instead). */
@EventHandler(COMMERCE_ORDER_AGGREGATE, RefundRequested.type, {
  consumerName: 'commerce.refund-under-review-mailer',
})
export class RefundUnderReviewMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(RefundUnderReviewMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly commerce: CommerceMailReader,
    private readonly mailer: Mailer,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(RefundRequested, envelope);
    const student = await this.contacts.find(trx, event.userId);
    if (student === null) {
      this.logger.warn(
        { refundId: event.refundId, userId: event.userId },
        'RefundRequested for an unknown user; no mail',
      );
      return;
    }
    const refund = await this.commerce.refund(trx, event.refundId);
    await this.mailer.send({
      to: student.email,
      ...refundUnderReviewMail({
        displayName: student.displayName,
        courseTitle: refund?.courseTitle ?? null,
        orderNumber: refund?.orderNumber ?? null,
        amount: event.amount,
        currency: event.currency,
        reasonCode: event.reasonCode,
        orderUrl: this.links.order(event.orderId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
