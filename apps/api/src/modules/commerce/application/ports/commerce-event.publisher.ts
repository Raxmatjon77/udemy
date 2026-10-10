import type {
  CouponCreatedPayload,
  CouponDeactivatedPayload,
  CoursePriceChangedPayload,
  OrderCanceledPayload,
  OrderExpiredPayload,
  OrderPaidPayload,
  OrderPaymentMismatchPayload,
  OrderPlacedPayload,
  PaymentDisputedPayload,
  RefundApprovedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Commerce integration events (design §7), written to the outbox in the caller's transaction.
 * Topic = aggregate type: `commerce.course_price` (key courseId), `commerce.coupon` (key
 * couponId) and `commerce.order` (key orderId: refund events share the order aggregate, so
 * they stay ordered after `OrderPaid`). P4-T16 adds RefundRequested / Rejected / Succeeded /
 * Failed here.
 */
export abstract class CommerceEventPublisher {
  abstract coursePriceChanged(
    trx: Transaction<DB>,
    payload: CoursePriceChangedPayload,
  ): Promise<void>;
  abstract couponCreated(trx: Transaction<DB>, payload: CouponCreatedPayload): Promise<void>;
  abstract couponDeactivated(
    trx: Transaction<DB>,
    payload: CouponDeactivatedPayload,
  ): Promise<void>;

  // commerce.order (P4-T15)
  abstract orderPlaced(trx: Transaction<DB>, payload: OrderPlacedPayload): Promise<void>;
  abstract orderPaid(trx: Transaction<DB>, payload: OrderPaidPayload): Promise<void>;
  abstract orderExpired(trx: Transaction<DB>, payload: OrderExpiredPayload): Promise<void>;
  abstract orderCanceled(trx: Transaction<DB>, payload: OrderCanceledPayload): Promise<void>;
  abstract orderPaymentMismatch(
    trx: Transaction<DB>,
    payload: OrderPaymentMismatchPayload,
  ): Promise<void>;
  abstract paymentDisputed(trx: Transaction<DB>, payload: PaymentDisputedPayload): Promise<void>;
  /** The D15 duplicate-purchase refund of the PAID path (SYSTEM, approved at once). */
  abstract refundApproved(trx: Transaction<DB>, payload: RefundApprovedPayload): Promise<void>;
}
