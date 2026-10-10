import { Injectable, Logger } from '@nestjs/common';
import {
  COMMERCE_ORDER_AGGREGATE,
  type EventEnvelope,
  OrderPaymentMismatch,
  PaymentDisputed,
  RefundFailed,
  RefundRequested,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import {
  type AdminRecipient,
  AdminRecipientsReader,
} from '../../shared/mail/admin-recipients.reader';
import type { RenderedMail } from '../../shared/mail/mail-layout';
import { CommerceLinks } from '../mail/commerce-links';
import {
  paymentDisputedAlertMail,
  paymentMismatchAlertMail,
  refundFailedAlertMail,
  refundReviewAlertMail,
} from '../mail/commerce-mail.templates';
import { CommerceMailReader } from '../persistence/commerce-mail.reader';

/*
 * `commerce.admin-alert-mailer` (Phase 4 design §7): payment mismatches and disputes, plus the
 * refund requests that need review and failed provider refunds. The registry needs one consumer
 * name per handler, so they are pinned as `commerce.admin-alert-mailer.<event>`.
 */

/**
 * One message per active admin (admins never see each other's addresses), in id order. The
 * Message-ID is `<eventId.adminId@udemy.local>`, stable across redeliveries; a failed send
 * retries the whole event and earlier admins get the same Message-ID again (deduplicable).
 */
@Injectable()
export class AdminAlertSender {
  private readonly logger = new Logger(AdminAlertSender.name);

  constructor(
    private readonly admins: AdminRecipientsReader,
    private readonly mailer: Mailer,
  ) {}

  async send(
    trx: Transaction<DB>,
    envelope: EventEnvelope,
    render: (admin: AdminRecipient) => RenderedMail,
  ): Promise<number> {
    const recipients = await this.admins.list(trx);
    if (recipients.length === 0) {
      this.logger.warn(
        { eventId: envelope.eventId, eventType: envelope.eventType },
        'Commerce alert but no active admin exists; no mail',
      );
      return 0;
    }
    for (const admin of recipients) {
      await this.mailer.send({
        to: admin.email,
        ...render(admin),
        messageId: eventMessageId(`${envelope.eventId}.${admin.userId}`),
      });
    }
    return recipients.length;
  }
}

/** `OrderPaymentMismatch`: the order is in PAYMENT_REVIEW and needs a decision. */
@EventHandler(COMMERCE_ORDER_AGGREGATE, OrderPaymentMismatch.type, {
  consumerName: 'commerce.admin-alert-mailer.payment-mismatch',
})
export class PaymentMismatchAlertHandler implements EventHandlerContract {
  constructor(
    private readonly alerts: AdminAlertSender,
    private readonly commerce: CommerceMailReader,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(OrderPaymentMismatch, envelope);
    const orderNumber = await this.commerce.orderNumber(trx, event.orderId);
    const orderUrl = this.links.adminOrder(event.orderId);
    await this.alerts.send(trx, envelope, (admin) =>
      paymentMismatchAlertMail({
        adminName: admin.displayName,
        orderNumber,
        expected: event.expected,
        received: event.received,
        providerEventId: event.providerEventId,
        detectedAt: new Date(event.detectedAt),
        orderUrl,
      }),
    );
  }
}

/** `PaymentDisputed`: a chargeback was opened. */
@EventHandler(COMMERCE_ORDER_AGGREGATE, PaymentDisputed.type, {
  consumerName: 'commerce.admin-alert-mailer.payment-disputed',
})
export class PaymentDisputedAlertHandler implements EventHandlerContract {
  constructor(
    private readonly alerts: AdminAlertSender,
    private readonly commerce: CommerceMailReader,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(PaymentDisputed, envelope);
    const orderNumber = await this.commerce.orderNumber(trx, event.orderId);
    const orderUrl = this.links.adminOrder(event.orderId);
    await this.alerts.send(trx, envelope, (admin) =>
      paymentDisputedAlertMail({
        adminName: admin.displayName,
        orderNumber,
        paymentIntentId: event.paymentIntentId,
        openedAt: new Date(event.openedAt),
        orderUrl,
      }),
    );
  }
}

/** `RefundRequested` (NEEDS_REVIEW): the admin side of the student's acknowledgement. */
@EventHandler(COMMERCE_ORDER_AGGREGATE, RefundRequested.type, {
  consumerName: 'commerce.admin-alert-mailer.refund-requested',
})
export class RefundReviewAlertHandler implements EventHandlerContract {
  constructor(
    private readonly alerts: AdminAlertSender,
    private readonly commerce: CommerceMailReader,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(RefundRequested, envelope);
    const refund = await this.commerce.refund(trx, event.refundId);
    const queueUrl = this.links.adminRefunds();
    await this.alerts.send(trx, envelope, (admin) =>
      refundReviewAlertMail({
        adminName: admin.displayName,
        courseTitle: refund?.courseTitle ?? null,
        orderNumber: refund?.orderNumber ?? null,
        amount: event.amount,
        currency: event.currency,
        reasonCode: event.reasonCode,
        requestedAt: new Date(event.requestedAt),
        queueUrl,
      }),
    );
  }
}

/** `RefundFailed`: the provider refund failed (FAILED queue). */
@EventHandler(COMMERCE_ORDER_AGGREGATE, RefundFailed.type, {
  consumerName: 'commerce.admin-alert-mailer.refund-failed',
})
export class RefundFailedAlertHandler implements EventHandlerContract {
  constructor(
    private readonly alerts: AdminAlertSender,
    private readonly commerce: CommerceMailReader,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(RefundFailed, envelope);
    const refund = await this.commerce.refund(trx, event.refundId);
    const queueUrl = this.links.adminRefunds();
    await this.alerts.send(trx, envelope, (admin) =>
      refundFailedAlertMail({
        adminName: admin.displayName,
        courseTitle: refund?.courseTitle ?? null,
        orderNumber: refund?.orderNumber ?? null,
        failureCode: event.failureCode,
        attempt: event.attempt,
        failedAt: new Date(event.failedAt),
        queueUrl,
      }),
    );
  }
}
