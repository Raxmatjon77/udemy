import { Injectable } from '@nestjs/common';
import {
  CouponCreated,
  type CouponCreatedPayload,
  CouponDeactivated,
  type CouponDeactivatedPayload,
  CoursePriceChanged,
  type CoursePriceChangedPayload,
  OrderCanceled,
  type OrderCanceledPayload,
  OrderExpired,
  type OrderExpiredPayload,
  OrderPaid,
  type OrderPaidPayload,
  OrderPaymentMismatch,
  type OrderPaymentMismatchPayload,
  OrderPlaced,
  type OrderPlacedPayload,
  PaymentDisputed,
  type PaymentDisputedPayload,
  RefundApproved,
  type RefundApprovedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { OutboxPublisher } from '../../../shared/outbox';
import { CommerceEventPublisher } from '../application/ports/commerce-event.publisher';

/** Commerce events through the transactional outbox (topic = aggregate type). */
@Injectable()
export class OutboxCommerceEventPublisher extends CommerceEventPublisher {
  constructor(private readonly outbox: OutboxPublisher) {
    super();
  }

  async coursePriceChanged(
    trx: Transaction<DB>,
    payload: CoursePriceChangedPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, CoursePriceChanged, payload.courseId, payload);
  }

  async couponCreated(trx: Transaction<DB>, payload: CouponCreatedPayload): Promise<void> {
    await this.outbox.publish(trx, CouponCreated, payload.couponId, payload);
  }

  async couponDeactivated(trx: Transaction<DB>, payload: CouponDeactivatedPayload): Promise<void> {
    await this.outbox.publish(trx, CouponDeactivated, payload.couponId, payload);
  }

  async orderPlaced(trx: Transaction<DB>, payload: OrderPlacedPayload): Promise<void> {
    await this.outbox.publish(trx, OrderPlaced, payload.orderId, payload);
  }

  async orderPaid(trx: Transaction<DB>, payload: OrderPaidPayload): Promise<void> {
    await this.outbox.publish(trx, OrderPaid, payload.orderId, payload);
  }

  async orderExpired(trx: Transaction<DB>, payload: OrderExpiredPayload): Promise<void> {
    await this.outbox.publish(trx, OrderExpired, payload.orderId, payload);
  }

  async orderCanceled(trx: Transaction<DB>, payload: OrderCanceledPayload): Promise<void> {
    await this.outbox.publish(trx, OrderCanceled, payload.orderId, payload);
  }

  async orderPaymentMismatch(
    trx: Transaction<DB>,
    payload: OrderPaymentMismatchPayload,
  ): Promise<void> {
    await this.outbox.publish(trx, OrderPaymentMismatch, payload.orderId, payload);
  }

  async paymentDisputed(trx: Transaction<DB>, payload: PaymentDisputedPayload): Promise<void> {
    await this.outbox.publish(trx, PaymentDisputed, payload.orderId, payload);
  }

  async refundApproved(trx: Transaction<DB>, payload: RefundApprovedPayload): Promise<void> {
    await this.outbox.publish(trx, RefundApproved, payload.orderId, payload);
  }
}
