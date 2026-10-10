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
  RefundFailedPayload,
  RefundRejectedPayload,
  RefundRequestedPayload,
  RefundSucceededPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Commerce integration events (design §7), written to the outbox in the caller's transaction.
 * Topic = aggregate type: `commerce.course_price` (key courseId), `commerce.coupon` (key
 * couponId) and `commerce.order` (key orderId: refund events share the order aggregate, so
 * they stay ordered after `OrderPaid`). The worker consumes them (P4-T14): RefundRequested
 * (`commerce.refund-under-review-mailer` + `commerce.admin-alert-mailer.refund-requested`),
 * RefundRejected (`commerce.refund-rejected-mailer`), RefundSucceeded (`commerce.refund-mailer`,
 * `payouts.ledger-writer`), RefundFailed (`commerce.admin-alert-mailer.refund-failed`).
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
  /** Every approval: auto, admin (new, review, retry) and the D15 SYSTEM refund. */
  abstract refundApproved(trx: Transaction<DB>, payload: RefundApprovedPayload): Promise<void>;
  /** A student request that needs review (NEEDS_REVIEW). */
  abstract refundRequested(trx: Transaction<DB>, payload: RefundRequestedPayload): Promise<void>;
  abstract refundRejected(trx: Transaction<DB>, payload: RefundRejectedPayload): Promise<void>;
  abstract refundSucceeded(trx: Transaction<DB>, payload: RefundSucceededPayload): Promise<void>;
  abstract refundFailed(trx: Transaction<DB>, payload: RefundFailedPayload): Promise<void>;
}
