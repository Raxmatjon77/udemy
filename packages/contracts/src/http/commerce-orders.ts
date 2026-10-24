import { z } from 'zod';
import { ErrorCode } from '../errors/error-code';
import { CurrencySchema, MoneyAmountSchema } from '../money/money';
import { PersonRefSchema } from './catalog';
import { CartQuoteSchema } from './commerce-cart';
import {
  CheckoutUrlSchema,
  CourseTitleSnapshotSchema,
  OrderNumberSchema,
  OrderSettlementProviderSchema,
  OrderStatusSchema,
  PaymentStatusSchema,
  RefundBlockReasonSchema,
  RefundCommentSchema,
  RefundInitiatorSchema,
  RefundReasonCodeSchema,
  RefundStatusSchema,
  StudentRefundReasonCodeSchema,
} from './commerce-common';
import { IsoDateTimeSchema, UuidSchema } from './fields';
import { CertificateStatusSchema } from './learning';
import { pageSchema, PaginationQuerySchema } from './pagination';
import { ProblemDetailsSchema } from './problem-details';

/* ----------------------------------------------------------------------------------------
 * POST /me/checkout  (P `order:create` + `Idempotency-Key` header)
 *   -> 201 CheckoutResponse
 *   400 idempotency_key_required, 403 email_not_verified,
 *   409 checkout_in_progress (CheckoutInProgressProblem) | price_changed (PriceChangedProblem)
 *       | cart_changed (CartChangedProblem),
 *   422 cart_empty | idempotency_key_reused | amount_below_minimum, 429,
 *   503 payment_provider_unavailable (retry with the SAME key: it resumes).
 *
 * Generate one UUID key per checkout attempt and keep it (sessionStorage) until success or a
 * definitive 4xx (§10). `expectedTotal` is only compared, never charged (§9).
 * -------------------------------------------------------------------------------------- */

/** Header name, lowercase as Node exposes it. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export const IdempotencyKeySchema = z.uuid();

/**
 * The checkout headers. A missing header is answered with 400 `idempotency_key_required`
 * (not `validation_failed`), so the api checks presence before applying this schema.
 */
export const CheckoutHeadersSchema = z.object({ [IDEMPOTENCY_KEY_HEADER]: IdempotencyKeySchema });
export type CheckoutHeaders = z.output<typeof CheckoutHeadersSchema>;

export const CheckoutRequestSchema = z.object({
  /** `CartQuote.totals.totalAmount` the buyer saw. */
  expectedTotal: MoneyAmountSchema,
});
export type CheckoutRequest = z.output<typeof CheckoutRequestSchema>;

/**
 * PAID (zero-total order, `checkoutUrl` null) or PENDING_PAYMENT (redirect to `checkoutUrl`
 * after checking its origin). A resumed key returns the order's current state.
 */
export const CheckoutResponseSchema = z.object({
  orderId: UuidSchema,
  status: OrderStatusSchema,
  checkoutUrl: CheckoutUrlSchema.nullable(),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

/** 409 `checkout_in_progress` (D15): offer "Resume payment" or "Cancel and start over". */
export const CheckoutInProgressProblemSchema = ProblemDetailsSchema.extend({
  code: z.literal(ErrorCode.CheckoutInProgress),
  orderId: UuidSchema,
  /** Null while the session is still being created (resume by retrying the same key). */
  checkoutUrl: CheckoutUrlSchema.nullable(),
});
export type CheckoutInProgressProblem = z.infer<typeof CheckoutInProgressProblemSchema>;

/** 409 `price_changed`: the fresh quote (refetch and show a toast). */
export const PriceChangedProblemSchema = ProblemDetailsSchema.extend({
  code: z.literal(ErrorCode.PriceChanged),
  quote: CartQuoteSchema,
});
export type PriceChangedProblem = z.infer<typeof PriceChangedProblemSchema>;

/** 409 `cart_changed`: a line became unavailable; the fresh quote. */
export const CartChangedProblemSchema = ProblemDetailsSchema.extend({
  code: z.literal(ErrorCode.CartChanged),
  quote: CartQuoteSchema,
});
export type CartChangedProblem = z.infer<typeof CartChangedProblemSchema>;

/* ----------------------------------------------------------------------------------------
 * Orders (student BFF):
 *
 *   GET  /me/orders?cursor=&limit=       -> 200 OrderSummaryPage  (P order:read:own)
 *   GET  /me/orders/:orderId             -> 200 OrderDetail       (Pol order:read; 404)
 *   GET  /me/orders/:orderId/receipt     -> 200 Receipt           (Pol order:read; 404, 409 order_not_paid)
 *   POST /me/orders/:orderId/cancel      -> 200 OrderDetail       (Pol order:read; 404, 409 order_not_cancelable)
 *
 * Keyset (placedAt DESC, id DESC). Foreign orders are 404 (policy). The success page polls
 * `GET /me/orders/:orderId` until PAID (§10).
 * -------------------------------------------------------------------------------------- */

export const OrderIdParamsSchema = z.object({ orderId: UuidSchema });
export type OrderIdParams = z.output<typeof OrderIdParamsSchema>;

export const MyOrdersQuerySchema = PaginationQuerySchema;
export type MyOrdersQuery = z.output<typeof MyOrdersQuerySchema>;

export const OrderSummarySchema = z.object({
  id: UuidSchema,
  orderNumber: OrderNumberSchema,
  status: OrderStatusSchema,
  currency: CurrencySchema,
  totalAmount: MoneyAmountSchema,
  lineCount: z.number().int().min(1),
  /** Line titles in line order (snapshots). */
  courseTitles: z.array(z.string()),
  placedAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
});
export type OrderSummary = z.infer<typeof OrderSummarySchema>;

export const OrderSummaryPageSchema = pageSchema(OrderSummarySchema);
export type OrderSummaryPage = z.infer<typeof OrderSummaryPageSchema>;

/** The refund situation of one order line, for the "Request refund" button. */
export const OrderLineRefundStateSchema = z.object({
  /** The live (or last) refund of the line, if any. */
  refundId: UuidSchema.nullable(),
  status: RefundStatusSchema.nullable(),
  /** `paid_at + COMMERCE_REFUND_WINDOW_DAYS`; null when not paid or not refundable at all. */
  refundableUntil: IsoDateTimeSchema.nullable(),
  /** A student refund request would be accepted now. */
  eligible: z.boolean(),
  /** Why not; null when eligible. */
  reason: RefundBlockReasonSchema.nullable(),
});
export type OrderLineRefundState = z.infer<typeof OrderLineRefundStateSchema>;

/**
 * Phase 5 refund review (design D8, P5-D6): the default `COMMERCE_REFUND_REVIEW_CONSUMED_PCT`.
 * A student refund request goes to admin review (REQUESTED) instead of being auto-approved when
 * the course has an ACTIVE certificate, or more than this percent of the live video seconds was
 * watched, or more than this percent of the live lectures was completed. It never blocks one.
 */
export const REFUND_REVIEW_CONSUMED_PCT = 30;

/**
 * Why the consumption rule sends a student refund request to review, checked in this order
 * with a strict `>` and integer arithmetic:
 *
 * - `certificate_issued`: the buyer holds an ACTIVE certificate for the course;
 * - `consumed_video_{pct}`: ⌊watched × 100 / live video seconds⌋ is over the threshold;
 * - `consumed_lectures_{pct}`: ⌊completed × 100 / live lectures⌋ is over the threshold.
 */
export const RefundReviewReasonSchema = z
  .string()
  .regex(/^(certificate_issued|consumed_(video|lectures)_(\d|[1-9]\d|100))$/);
export type RefundReviewReason = z.infer<typeof RefundReviewReasonSchema>;

/**
 * How much of the course the buyer has consumed (Phase 5 design D8, read live from learning,
 * at most one progress flush, ≤ 15 s, behind). Only the LIVE revision counts: watched seconds are
 * covered 5 s buckets of the live video assets, clamped per lecture; a re-uploaded video starts
 * from zero. Progress is kept after a refund, so the figures stay readable.
 */
export const CourseConsumptionSchema = z.object({
  videoSecondsWatched: z.number().int().min(0),
  /** Σ live VIDEO durations; 0 when the course has no video. */
  videoSecondsTotal: z.number().int().min(0),
  /** ⌊videoSecondsWatched × 100 / videoSecondsTotal⌋; 0 when there is no video. */
  videoPct: z.number().int().min(0).max(100),
  /** Completed lectures ∩ live lecture ids. */
  completedLectures: z.number().int().min(0),
  totalLectures: z.number().int().min(0),
  /** ⌊completedLectures × 100 / totalLectures⌋; 0 for an empty curriculum. */
  lecturesPct: z.number().int().min(0).max(100),
  /** The permanent course completion (kept when later revisions add lectures). */
  courseCompletedAt: IsoDateTimeSchema.nullable(),
  certificateStatus: CertificateStatusSchema.nullable(),
  /**
   * What the consumption rule says about a student refund request made NOW; null = no
   * objection. The D11 abuse count (3 refunds in 90 days) is separate and not reflected here.
   */
  reviewReason: RefundReviewReasonSchema.nullable(),
});
export type CourseConsumption = z.infer<typeof CourseConsumptionSchema>;

export const OrderLineSchema = z.object({
  id: UuidSchema,
  lineNo: z.number().int().min(1),
  courseId: UuidSchema,
  /**
   * The course's CURRENT slug, for links (`/courses/{slug}`); null when the course no longer
   * exists (deleted). Additive (P4-T15).
   */
  slug: z.string().min(1).nullable(),
  /** Snapshot at purchase (D6). */
  courseTitle: CourseTitleSnapshotSchema,
  /** Resolved live; null when the instructor is banned or unknown. */
  instructor: PersonRefSchema.nullable(),
  listAmount: MoneyAmountSchema,
  discountAmount: MoneyAmountSchema,
  finalAmount: MoneyAmountSchema,
  couponCode: z.string().nullable(),
  refund: OrderLineRefundStateSchema,
  /**
   * Additive (Phase 5, P5-T16): the buyer's consumption of the course, for the refund dialog
   * hint ("You've watched N% of this course; your request will be reviewed" when
   * `consumption.reviewReason` is set). Null unless `refund.eligible`.
   */
  consumption: CourseConsumptionSchema.nullable(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderPaymentSummarySchema = z.object({
  provider: OrderSettlementProviderSchema,
  /** Null for a zero-total order (no payment row). */
  status: PaymentStatusSchema.nullable(),
});
export type OrderPaymentSummary = z.infer<typeof OrderPaymentSummarySchema>;

export const OrderDetailSchema = z.object({
  id: UuidSchema,
  orderNumber: OrderNumberSchema,
  status: OrderStatusSchema,
  currency: CurrencySchema,
  /** Σ list amounts. */
  subtotalAmount: MoneyAmountSchema,
  /** Σ discounts. */
  discountAmount: MoneyAmountSchema,
  totalAmount: MoneyAmountSchema,
  /** Σ SUCCEEDED refunds. */
  refundedAmount: MoneyAmountSchema,
  placedAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  lines: z.array(OrderLineSchema).min(1),
  payment: OrderPaymentSummarySchema,
  /** PENDING_PAYMENT with an OPEN session only ("Resume payment"); a bearer capability. */
  checkoutUrl: CheckoutUrlSchema.nullable(),
});
export type OrderDetail = z.infer<typeof OrderDetailSchema>;

export const CancelOrderResponseSchema = OrderDetailSchema;
export type CancelOrderResponse = OrderDetail;

/** Printable receipt (`@media print`). No card details are stored, not even last4 (§9 PCI). */
export const ReceiptSchema = z.object({
  orderId: UuidSchema,
  orderNumber: OrderNumberSchema,
  /** The payment date. */
  issuedAt: IsoDateTimeSchema,
  buyer: z.object({ displayName: z.string() }),
  currency: CurrencySchema,
  lines: z
    .array(
      z.object({
        courseTitle: z.string(),
        listAmount: MoneyAmountSchema,
        discountAmount: MoneyAmountSchema,
        finalAmount: MoneyAmountSchema,
        couponCode: z.string().nullable(),
      }),
    )
    .min(1),
  subtotalAmount: MoneyAmountSchema,
  discountAmount: MoneyAmountSchema,
  totalAmount: MoneyAmountSchema,
  refundedAmount: MoneyAmountSchema,
  /** NONE for a zero-total order (100% coupon, D14). */
  paymentProvider: OrderSettlementProviderSchema,
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /me/orders/:orderId/refunds -> 201 Refund
 *   (Pol order:refund; 404 order/line, 409 refund_already_requested,
 *    422 refund_window_closed | refund_not_applicable, 429; 5 per 24 h)
 * Full line only (D11). AUTO_APPROVE answers APPROVED (access is revoked at once);
 * NEEDS_REVIEW answers REQUESTED ("under review"): 3+ counted refunds in 90 days, or (Phase 5)
 * a consumption objection (`RefundReviewReason`, see `CourseConsumption`).
 * -------------------------------------------------------------------------------------- */

export const RequestRefundRequestSchema = z.object({
  orderLineId: UuidSchema,
  reasonCode: StudentRefundReasonCodeSchema,
  comment: RefundCommentSchema.optional(),
});
export type RequestRefundRequest = z.output<typeof RequestRefundRequestSchema>;

export const RefundSchema = z.object({
  id: UuidSchema,
  orderId: UuidSchema,
  orderLineId: UuidSchema,
  courseId: UuidSchema,
  courseTitle: z.string(),
  /** Always the full line amount. */
  amount: MoneyAmountSchema,
  currency: CurrencySchema,
  status: RefundStatusSchema,
  initiatedBy: RefundInitiatorSchema,
  reasonCode: RefundReasonCodeSchema,
  comment: z.string().nullable(),
  /** The admin's reason when REJECTED. */
  rejectionReason: z.string().nullable(),
  attempt: z.number().int().min(1),
  createdAt: IsoDateTimeSchema,
  approvedAt: IsoDateTimeSchema.nullable(),
  succeededAt: IsoDateTimeSchema.nullable(),
});
export type Refund = z.infer<typeof RefundSchema>;

export const RequestRefundResponseSchema = RefundSchema;
export type RequestRefundResponse = Refund;

/** Refund requests per user per 24 h (§9). */
export const REFUND_REQUESTS_PER_DAY = 5;
