import { Logger } from '@nestjs/common';
import { COMMERCE_ORDER_AGGREGATE, type EventEnvelope, OrderPaid } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { CommerceLinks } from '../mail/commerce-links';
import { orderReceiptMail } from '../mail/commerce-mail.templates';

/**
 * `OrderPaid` -> the buyer's receipt (Phase 4 design §7): every line with its list price,
 * discount (coupon code) and final amount, the total, and a link to
 * `${STUDENT_APP_ORIGIN}/account/orders/{orderId}/receipt`. Lines and amounts come from the
 * event (the immutable order_lines snapshot); only the address is read at handling time.
 * Zero-total orders (provider NONE) get a "nothing was charged" receipt.
 */
@EventHandler(COMMERCE_ORDER_AGGREGATE, OrderPaid.type, {
  consumerName: 'commerce.receipt-mailer',
})
export class ReceiptMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(ReceiptMailerHandler.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: CommerceLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(OrderPaid, envelope);
    const buyer = await this.contacts.find(trx, event.userId);
    if (buyer === null) {
      this.logger.warn(
        { orderId: event.orderId, userId: event.userId },
        'OrderPaid for an unknown buyer; no receipt',
      );
      return;
    }
    await this.mailer.send({
      to: buyer.email,
      ...orderReceiptMail({
        displayName: buyer.displayName,
        orderNumber: event.orderNumber,
        currency: event.currency,
        totalAmount: event.totalAmount,
        paidAt: new Date(event.paidAt),
        free: event.provider === 'NONE',
        lines: event.lines,
        receiptUrl: this.links.receipt(event.orderId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
