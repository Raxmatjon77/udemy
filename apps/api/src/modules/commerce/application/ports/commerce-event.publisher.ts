import type {
  CouponCreatedPayload,
  CouponDeactivatedPayload,
  CoursePriceChangedPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/**
 * Commerce integration events (design §7), written to the outbox in the caller's transaction.
 * Topic = aggregate type: `commerce.course_price` (key courseId), `commerce.coupon` (key
 * couponId). P4-T15/T16 add the `commerce.order` events (key orderId) here.
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
}
