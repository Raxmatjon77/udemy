import { z } from 'zod';
import {
  CouponDiscountTypeSchema,
  CouponScopeSchema,
  OrderSettlementProviderSchema,
  RefundInitiatorSchema,
  RefundReasonCodeSchema,
} from '../http/commerce-common';
import { MONEY_AMOUNT_PATTERN } from '../money/money';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/**
 * Commerce events (Phase 4 design §7). Payloads carry no PII (ids, titles, amounts), so the
 * topics use broker-default retention. Money is a canonical decimal string, never a float.
 *
 * **Refund events share the order aggregate** (`commerce.order`, key = orderId), which keeps
 * them strictly ordered after the order's `OrderPaid`; the payouts ledger writer relies on it.
 */
export const COMMERCE_ORDER_AGGREGATE = 'commerce.order';
export const COMMERCE_COURSE_PRICE_AGGREGATE = 'commerce.course_price';
export const COMMERCE_COUPON_AGGREGATE = 'commerce.coupon';

const orderOptions = { aggregateType: COMMERCE_ORDER_AGGREGATE } as const;
const priceOptions = { aggregateType: COMMERCE_COURSE_PRICE_AGGREGATE } as const;
const couponOptions = { aggregateType: COMMERCE_COUPON_AGGREGATE } as const;

/** Lenient shape guards: the domain `Money` VO already enforced the allowlist and tiers. */
const money = () => z.string().regex(MONEY_AMOUNT_PATTERN, 'Invalid money amount');
const currency = () => z.string().regex(/^[A-Z]{3}$/, 'Invalid currency');
const orderNumber = () => z.number().int().min(1);
const courseTitle = () => z.string().min(1).max(60);
const couponCode = () => z.string().min(4).max(20);
/** Stripe event ids (`evt_…`) or synthetic reconciler ids (`reconcile:{sessionId}:{status}`). */
const providerRef = () => z.string().min(1).max(255);

/** Causes per terminal transition (subsets of `ORDER_TRANSITION_CAUSES`). */
export const ORDER_EXPIRED_CAUSES = ['PROVIDER_EVENT', 'RECONCILER'] as const;
export const OrderExpiredCauseSchema = z.enum(ORDER_EXPIRED_CAUSES);
export const ORDER_CANCELED_CAUSES = ['USER_CANCEL', 'RECONCILER'] as const;
export const OrderCanceledCauseSchema = z.enum(ORDER_CANCELED_CAUSES);

/* ----------------------------------------------------------------------------------------
 * commerce.order
 * -------------------------------------------------------------------------------------- */

export const OrderPlaced = defineEvent(
  'OrderPlaced',
  1,
  z.object({
    orderId: eventId(),
    orderNumber: orderNumber(),
    userId: eventId(),
    currency: currency(),
    totalAmount: money(),
    lineCount: z.number().int().min(1),
    placedAt: eventTimestamp(),
  }),
  orderOptions,
);

/** One sold line, as snapshotted on `order_lines` (shares computed by the DB, D3). */
export const OrderPaidLineSchema = z.object({
  orderLineId: eventId(),
  courseId: eventId(),
  instructorId: eventId(),
  courseTitle: courseTitle(),
  listAmount: money(),
  discountAmount: money(),
  finalAmount: money(),
  couponId: eventId().nullable(),
  couponCode: couponCode().nullable(),
  revenueShareBps: z.number().int().min(0).max(10_000),
  instructorShareAmount: money(),
  platformShareAmount: money(),
});

/** Consumed by `commerce.receipt-mailer` and `payouts.ledger-writer`. */
export const OrderPaid = defineEvent(
  'OrderPaid',
  1,
  z.object({
    orderId: eventId(),
    orderNumber: orderNumber(),
    userId: eventId(),
    currency: currency(),
    totalAmount: money(),
    /** NONE: a zero-total order (D14). */
    provider: OrderSettlementProviderSchema,
    paidAt: eventTimestamp(),
    lines: z.array(OrderPaidLineSchema).min(1),
  }),
  orderOptions,
);

export const OrderExpired = defineEvent(
  'OrderExpired',
  1,
  z.object({
    orderId: eventId(),
    userId: eventId(),
    cause: OrderExpiredCauseSchema,
    expiredAt: eventTimestamp(),
  }),
  orderOptions,
);

export const OrderCanceled = defineEvent(
  'OrderCanceled',
  1,
  z.object({
    orderId: eventId(),
    userId: eventId(),
    cause: OrderCanceledCauseSchema,
    canceledAt: eventTimestamp(),
  }),
  orderOptions,
);

const moneyValue = () => z.object({ amount: money(), currency: currency() });

/** The provider charged something other than the order total: PAYMENT_REVIEW, admin alert. */
export const OrderPaymentMismatch = defineEvent(
  'OrderPaymentMismatch',
  1,
  z.object({
    orderId: eventId(),
    expected: moneyValue(),
    received: moneyValue(),
    providerEventId: providerRef(),
    detectedAt: eventTimestamp(),
  }),
  orderOptions,
);

/** NEEDS_REVIEW: student acknowledgement mail + admin alert. */
export const RefundRequested = defineEvent(
  'RefundRequested',
  1,
  z.object({
    refundId: eventId(),
    orderId: eventId(),
    orderLineId: eventId(),
    userId: eventId(),
    courseId: eventId(),
    currency: currency(),
    amount: money(),
    reasonCode: RefundReasonCodeSchema,
    requestedAt: eventTimestamp(),
  }),
  orderOptions,
);

/** `approvedBy` is null for auto-approval and SYSTEM (duplicate purchase) refunds. */
export const RefundApproved = defineEvent(
  'RefundApproved',
  1,
  z.object({
    refundId: eventId(),
    orderId: eventId(),
    orderLineId: eventId(),
    initiatedBy: RefundInitiatorSchema,
    approvedBy: eventId().nullable(),
    approvedAt: eventTimestamp(),
  }),
  orderOptions,
);

/** The reason is mailed to the student. */
export const RefundRejected = defineEvent(
  'RefundRejected',
  1,
  z.object({
    refundId: eventId(),
    orderId: eventId(),
    userId: eventId(),
    reason: z.string().min(10).max(2000),
    rejectedAt: eventTimestamp(),
  }),
  orderOptions,
);

/** Consumed by `commerce.refund-mailer` and `payouts.ledger-writer` (mirror entry). */
export const RefundSucceeded = defineEvent(
  'RefundSucceeded',
  1,
  z.object({
    refundId: eventId(),
    orderId: eventId(),
    orderLineId: eventId(),
    userId: eventId(),
    courseId: eventId(),
    instructorId: eventId(),
    currency: currency(),
    amount: money(),
    instructorShareAmount: money(),
    platformShareAmount: money(),
    succeededAt: eventTimestamp(),
  }),
  orderOptions,
);

export const RefundFailed = defineEvent(
  'RefundFailed',
  1,
  z.object({
    refundId: eventId(),
    orderId: eventId(),
    failureCode: z.string().min(1).max(100),
    attempt: z.number().int().min(1),
    failedAt: eventTimestamp(),
  }),
  orderOptions,
);

/** No automatic revoke in Phase 4: admin alert only. */
export const PaymentDisputed = defineEvent(
  'PaymentDisputed',
  1,
  z.object({
    orderId: eventId(),
    paymentIntentId: providerRef(),
    openedAt: eventTimestamp(),
  }),
  orderOptions,
);

/** Every v1 event on the `commerce.order` topic. */
export const COMMERCE_ORDER_EVENTS = [
  OrderPlaced,
  OrderPaid,
  OrderExpired,
  OrderCanceled,
  OrderPaymentMismatch,
  RefundRequested,
  RefundApproved,
  RefundRejected,
  RefundSucceeded,
  RefundFailed,
  PaymentDisputed,
] as const;

/* ----------------------------------------------------------------------------------------
 * commerce.course_price (aggregateId = courseId)
 * -------------------------------------------------------------------------------------- */

export const CoursePriceChanged = defineEvent(
  'CoursePriceChanged',
  1,
  z.object({
    courseId: eventId(),
    previousAmount: money().nullable(),
    amount: money(),
    currency: currency(),
    changedBy: eventId(),
    changedAt: eventTimestamp(),
  }),
  priceOptions,
);

/** Every v1 event on the `commerce.course_price` topic. */
export const COMMERCE_COURSE_PRICE_EVENTS = [CoursePriceChanged] as const;

/* ----------------------------------------------------------------------------------------
 * commerce.coupon (aggregateId = couponId)
 * -------------------------------------------------------------------------------------- */

/** The full immutable terms (D5), mirroring the `coupons` CHECKs. */
export const CouponCreated = defineEvent(
  'CouponCreated',
  1,
  z
    .object({
      couponId: eventId(),
      scope: CouponScopeSchema,
      courseId: eventId().nullable(),
      code: couponCode(),
      discountType: CouponDiscountTypeSchema,
      percentOff: z.number().int().min(1).max(100).nullable(),
      amountOff: money().nullable(),
      currency: currency().nullable(),
      startsAt: eventTimestamp(),
      endsAt: eventTimestamp(),
      maxRedemptions: z.number().int().min(1).nullable(),
      actorId: eventId(),
      createdAt: eventTimestamp(),
    })
    .refine((p) => (p.scope === 'COURSE') === (p.courseId !== null), {
      message: 'A COURSE coupon has a courseId, a PLATFORM coupon has none',
      path: ['courseId'],
    })
    .refine(
      (p) =>
        p.discountType === 'PERCENT'
          ? p.percentOff !== null && p.amountOff === null
          : p.amountOff !== null && p.percentOff === null && p.currency !== null,
      { message: 'Exactly one of percentOff / amountOff (with currency)', path: ['discountType'] },
    )
    .refine((p) => p.scope === 'COURSE' || p.discountType === 'PERCENT', {
      message: 'Platform coupons are PERCENT only',
      path: ['discountType'],
    }),
  couponOptions,
);

export const CouponDeactivated = defineEvent(
  'CouponDeactivated',
  1,
  z
    .object({
      couponId: eventId(),
      scope: CouponScopeSchema,
      courseId: eventId().nullable(),
      code: couponCode(),
      actorId: eventId(),
      deactivatedAt: eventTimestamp(),
    })
    .refine((p) => (p.scope === 'COURSE') === (p.courseId !== null), {
      message: 'A COURSE coupon has a courseId, a PLATFORM coupon has none',
      path: ['courseId'],
    }),
  couponOptions,
);

/** Every v1 event on the `commerce.coupon` topic. */
export const COMMERCE_COUPON_EVENTS = [CouponCreated, CouponDeactivated] as const;

export type OrderPlacedPayload = EventPayload<typeof OrderPlaced>;
export type OrderPaidPayload = EventPayload<typeof OrderPaid>;
export type OrderPaidLine = z.infer<typeof OrderPaidLineSchema>;
export type OrderExpiredPayload = EventPayload<typeof OrderExpired>;
export type OrderCanceledPayload = EventPayload<typeof OrderCanceled>;
export type OrderPaymentMismatchPayload = EventPayload<typeof OrderPaymentMismatch>;
export type RefundRequestedPayload = EventPayload<typeof RefundRequested>;
export type RefundApprovedPayload = EventPayload<typeof RefundApproved>;
export type RefundRejectedPayload = EventPayload<typeof RefundRejected>;
export type RefundSucceededPayload = EventPayload<typeof RefundSucceeded>;
export type RefundFailedPayload = EventPayload<typeof RefundFailed>;
export type PaymentDisputedPayload = EventPayload<typeof PaymentDisputed>;
export type CoursePriceChangedPayload = EventPayload<typeof CoursePriceChanged>;
export type CouponCreatedPayload = EventPayload<typeof CouponCreated>;
export type CouponDeactivatedPayload = EventPayload<typeof CouponDeactivated>;
