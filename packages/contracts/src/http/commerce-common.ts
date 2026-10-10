import { z } from 'zod';
import { ErrorCode } from '../errors/error-code';
import { multilineText, UuidSchema } from './fields';

/**
 * Commerce enums and shared field schemas (Phase 4 design §4, §6). Every enum mirrors a
 * `commerce.*` CHECK constraint; the api domain stays authoritative.
 */

/* ----------------------------------------------------------------------------------------
 * Orders and payments
 * -------------------------------------------------------------------------------------- */

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'PAYMENT_REVIEW',
  'EXPIRED',
  'CANCELED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** Statuses in which the order was paid (`paid_at` is set). */
export const PAID_ORDER_STATUSES = [
  'PAID',
  'PAYMENT_REVIEW',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const satisfies readonly OrderStatus[];

export const ORDER_TRANSITION_CAUSES = [
  'CHECKOUT',
  'ZERO_TOTAL',
  'PROVIDER_EVENT',
  'USER_CANCEL',
  'RECONCILER',
  'REFUND',
  'ADMIN',
] as const;
export const OrderTransitionCauseSchema = z.enum(ORDER_TRANSITION_CAUSES);
export type OrderTransitionCause = z.infer<typeof OrderTransitionCauseSchema>;

export const PAYMENT_STATUSES = ['CREATING', 'OPEN', 'SUCCEEDED', 'EXPIRED', 'ABANDONED'] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

/** `payments.provider`. */
export const PAYMENT_PROVIDERS = ['STRIPE'] as const;
export const PaymentProviderSchema = z.enum(PAYMENT_PROVIDERS);
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;

/** How an order was settled: through a provider, or NONE for a zero-total order (D14). */
export const ORDER_SETTLEMENT_PROVIDERS = ['STRIPE', 'NONE'] as const;
export const OrderSettlementProviderSchema = z.enum(ORDER_SETTLEMENT_PROVIDERS);
export type OrderSettlementProvider = z.infer<typeof OrderSettlementProviderSchema>;

export const PROVIDER_EVENT_OUTCOMES = [
  'APPLIED',
  'DUPLICATE_EFFECT',
  'IGNORED',
  'ORPHAN',
  'MISMATCH',
] as const;
export const ProviderEventOutcomeSchema = z.enum(PROVIDER_EVENT_OUTCOMES);
export type ProviderEventOutcome = z.infer<typeof ProviderEventOutcomeSchema>;

/* ----------------------------------------------------------------------------------------
 * Refunds
 * -------------------------------------------------------------------------------------- */

export const REFUND_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
] as const;
export const RefundStatusSchema = z.enum(REFUND_STATUSES);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;

export const REFUND_INITIATORS = ['STUDENT', 'ADMIN', 'SYSTEM'] as const;
export const RefundInitiatorSchema = z.enum(REFUND_INITIATORS);
export type RefundInitiator = z.infer<typeof RefundInitiatorSchema>;

export const REFUND_REASON_CODES = [
  'NOT_AS_EXPECTED',
  'QUALITY',
  'ACCIDENTAL_PURCHASE',
  'DUPLICATE_PURCHASE',
  'PAYMENT_REVIEW',
  'ADMIN_DISCRETION',
  'OTHER',
] as const;
export const RefundReasonCodeSchema = z.enum(REFUND_REASON_CODES);
export type RefundReasonCode = z.infer<typeof RefundReasonCodeSchema>;

/** The reasons a student may pick; the others are set by the system or an admin. */
export const STUDENT_REFUND_REASON_CODES = [
  'NOT_AS_EXPECTED',
  'QUALITY',
  'ACCIDENTAL_PURCHASE',
  'OTHER',
] as const satisfies readonly RefundReasonCode[];
export const StudentRefundReasonCodeSchema = z.enum(STUDENT_REFUND_REASON_CODES);
export type StudentRefundReasonCode = z.infer<typeof StudentRefundReasonCodeSchema>;

export const REFUND_REASON_LABELS: Readonly<Record<RefundReasonCode, string>> = Object.freeze({
  NOT_AS_EXPECTED: 'The course is not what I expected',
  QUALITY: 'Content or audio/video quality',
  ACCIDENTAL_PURCHASE: 'I bought it by accident',
  DUPLICATE_PURCHASE: 'Duplicate purchase',
  PAYMENT_REVIEW: 'Payment under review',
  ADMIN_DISCRETION: 'Refunded by support',
  OTHER: 'Other',
});

/** `refunds.comment` ≤ 1000 (§6). */
export const RefundCommentSchema = multilineText(1, 1000);

/** Every admin money action carries a reason (§9 audit): 10–2000. */
export const AdminMoneyReasonSchema = multilineText(10, 2000);

/* ----------------------------------------------------------------------------------------
 * Coupons
 * -------------------------------------------------------------------------------------- */

export const COUPON_SCOPES = ['COURSE', 'PLATFORM'] as const;
export const CouponScopeSchema = z.enum(COUPON_SCOPES);
export type CouponScope = z.infer<typeof CouponScopeSchema>;

export const COUPON_DISCOUNT_TYPES = ['PERCENT', 'AMOUNT'] as const;
export const CouponDiscountTypeSchema = z.enum(COUPON_DISCOUNT_TYPES);
export type CouponDiscountType = z.infer<typeof CouponDiscountTypeSchema>;

/** Derived coupon state (§4); only `deactivated_at` is stored. */
export const COUPON_STATES = [
  'SCHEDULED',
  'ACTIVE',
  'EXHAUSTED',
  'EXPIRED',
  'DEACTIVATED',
] as const;
export const CouponStateSchema = z.enum(COUPON_STATES);
export type CouponState = z.infer<typeof CouponStateSchema>;

export const COUPON_REDEMPTION_STATUSES = ['RESERVED', 'CONSUMED', 'RELEASED'] as const;
export const CouponRedemptionStatusSchema = z.enum(COUPON_REDEMPTION_STATUSES);
export type CouponRedemptionStatus = z.infer<typeof CouponRedemptionStatusSchema>;

/** Coupon codes (D5): `^[A-Z0-9_-]{4,20}$`, the `carts.coupon_code` / `coupons.code` CHECK. */
export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{4,20}$/;

/** A coupon code in a request: trimmed and uppercased, then checked against the pattern. */
export const CouponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(COUPON_CODE_PATTERN, '4–20 letters, digits, "_" or "-"')
  .meta({ examples: ['LAUNCH50'] });

/** Codes a coupon apply can fail with (422); the quote reports the same codes per cart. */
export const COUPON_PROBLEM_CODES = [
  ErrorCode.CouponInvalid,
  ErrorCode.CouponExpired,
  ErrorCode.CouponNotStarted,
  ErrorCode.CouponExhausted,
  ErrorCode.CouponAlreadyUsed,
] as const;
export const CouponProblemCodeSchema = z.enum(COUPON_PROBLEM_CODES);
export type CouponProblemCode = z.infer<typeof CouponProblemCodeSchema>;

/* ----------------------------------------------------------------------------------------
 * Purchase eligibility (§4: the checks in order, each with its error code)
 * -------------------------------------------------------------------------------------- */

/** Why a course cannot be (or no longer is) bought; the values are problem codes. */
export const PURCHASE_BLOCK_REASONS = [
  ErrorCode.CourseNotFound,
  ErrorCode.CourseNotForSale,
  ErrorCode.CourseIsFree,
  ErrorCode.CannotPurchaseOwnCourse,
  ErrorCode.AlreadyEnrolled,
] as const;
export const PurchaseBlockReasonSchema = z.enum(PURCHASE_BLOCK_REASONS);
export type PurchaseBlockReason = z.infer<typeof PurchaseBlockReasonSchema>;

/** Why a refund is not possible for a line right now. */
export const REFUND_BLOCK_REASONS = [
  ErrorCode.RefundWindowClosed,
  ErrorCode.RefundNotApplicable,
  ErrorCode.RefundAlreadyRequested,
] as const;
export const RefundBlockReasonSchema = z.enum(REFUND_BLOCK_REASONS);
export type RefundBlockReason = z.infer<typeof RefundBlockReasonSchema>;

/* ----------------------------------------------------------------------------------------
 * Shared fields
 * -------------------------------------------------------------------------------------- */

/**
 * Stripe Checkout URL (a bearer capability: never log it). http is allowed because the dev and
 * CI emulator serves `http://127.0.0.1:12111`; the web app still checks the origin against
 * `CHECKOUT_ALLOWED_ORIGINS` before redirecting (§10).
 */
export const CheckoutUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .meta({ examples: ['https://checkout.stripe.com/c/pay/cs_test_a1'] });

/** Human order number (`orders.order_number`, an identity column). */
export const OrderNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** `order_lines.revenue_share_bps` 0–10000 (§6). */
export const RevenueShareBpsSchema = z.number().int().min(0).max(10_000);

/** `order_lines.course_title` snapshot (1–60, the course title bound). */
export const CourseTitleSnapshotSchema = z.string().min(1).max(60);

/** Accepts `?courseIds=a,b` and repeated `?courseIds=a&courseIds=b`. */
function splitCommaList(value: unknown): unknown {
  if (typeof value === 'string') return value === '' ? [] : value.split(',');
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => (typeof item === 'string' ? item.split(',') : [item]));
  }
  return value;
}

/** A required `?<name>=a,b,c` query of 1–`max` unique UUIDs. */
export function uuidListParam(max: number) {
  return z.preprocess(
    splitCommaList,
    z
      .array(UuidSchema)
      .min(1)
      .max(max)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' }),
  );
}
