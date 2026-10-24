import { ErrorCode, type ProblemCode } from '../errors/error-code.js';
import {
  type AdminOrderDetail,
  AdminOrderDetailSchema,
  type AdminOrderLine,
  AdminOrderLineSchema,
  type AdminOrderRow,
  AdminOrderRowSchema,
  type AdminOrderRefund,
  AdminOrderRefundSchema,
  type AdminRefund,
  type AdminRefundQueueItem,
  AdminRefundQueueItemSchema,
  AdminRefundSchema,
} from '../http/commerce-admin.js';
import {
  type CartLine,
  CartLineSchema,
  type CartQuote,
  CartQuoteSchema,
  type PurchaseState,
  PurchaseStateSchema,
} from '../http/commerce-cart.js';
import { INSTRUCTOR_SHARE_BPS } from '../http/commerce-common.js';
import { type Coupon, CouponSchema } from '../http/commerce-coupons.js';
import {
  type CheckoutInProgressProblem,
  CheckoutInProgressProblemSchema,
  type CheckoutResponse,
  CheckoutResponseSchema,
  type CourseConsumption,
  CourseConsumptionSchema,
  type OrderDetail,
  OrderDetailSchema,
  type OrderLine,
  OrderLineSchema,
  type OrderSummary,
  OrderSummarySchema,
  type Receipt,
  ReceiptSchema,
  type Refund,
  RefundSchema,
} from '../http/commerce-orders.js';
import {
  type CoursePricing,
  CoursePricingSchema,
  type PublicPrice,
  PublicPriceSchema,
} from '../http/commerce-pricing.js';
import {
  type RecentSale,
  RecentSaleSchema,
  type SalesSummary,
  SalesSummarySchema,
  type SalesTotals,
} from '../http/commerce-sales.js';
import {
  type Enrollment,
  EnrollmentSchema,
  type LearningCard,
  LearningCardSchema,
} from '../http/enrollment.js';
import type { ProblemDetails } from '../http/problem-details.js';
import { isFreeAmount } from '../money/price-tiers.js';
import { minorToMoney, moneyToMinor, subtractMoneyFloored, sumMoney } from '../money/money.js';

/**
 * Fixture builders for the Phase 4 commerce & enrollment contracts. Every builder returns a
 * value **parsed by its contracts schema**, so a fixture can never drift from the contract:
 * an invalid override throws a ZodError in the test that made it.
 *
 * Defaults are deterministic (fixed ids and `FIXTURE_NOW`); amounts that derive from others
 * (final = list − discount, totals = Σ lines) are recomputed unless overridden.
 */

/** A deterministic uuidv7-shaped id: `fixtureId(1)` → `0199c9a1-7d2e-7c4a-9b1e-000000000001`. */
export function fixtureId(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffffffff) {
    throw new RangeError(`fixtureId needs an integer in 0..2^48-1, got ${n}`);
  }
  return `0199c9a1-7d2e-7c4a-9b1e-${n.toString(16).padStart(12, '0')}`;
}

export const FIXTURE_NOW = '2026-10-10T12:00:00.000Z';

/** Well-known ids used by the defaults (and by `createCommerceMockStore`). */
export const FIXTURE_IDS = Object.freeze({
  student: fixtureId(0x5701),
  instructor: fixtureId(0x1157),
  admin: fixtureId(0xad01),
  course: fixtureId(0xc001),
  course2: fixtureId(0xc002),
  freeCourse: fixtureId(0xc0f0),
  order: fixtureId(0x0d01),
  orderLine: fixtureId(0x0d11),
  coupon: fixtureId(0xc0c0),
  refund: fixtureId(0x4ef0),
  enrollment: fixtureId(0xe001),
});

/** A 64-hex fingerprint; cheap and deterministic (not cryptographic, runs in browsers too). */
export function fixtureFingerprint(input: string): string {
  let out = '';
  for (let seed = 0; seed < 8; seed += 1) {
    let hash = 0x811c9dc5 ^ seed;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    out += (hash >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

/** `round(final × bps / 10000, 2)` half up, as the DB generated column (D3). */
export function instructorShareOf(finalAmount: string, revenueShareBps: number): string {
  return minorToMoney(Math.floor((moneyToMinor(finalAmount) * revenueShareBps + 5000) / 10000));
}

export const DEFAULT_REVENUE_SHARE_BPS = INSTRUCTOR_SHARE_BPS;

/* ---------------------------------------------------------------------------------------- */

export function makePublicPrice(overrides: Partial<PublicPrice> = {}): PublicPrice {
  const amount = overrides.amount ?? '19.99';
  return PublicPriceSchema.parse({
    courseId: FIXTURE_IDS.course,
    amount,
    currency: 'USD',
    isFree: isFreeAmount(amount),
    slug: 'complete-typescript',
    title: 'Complete TypeScript',
    ...overrides,
  });
}

export function makeCoursePricing(overrides: Partial<CoursePricing> = {}): CoursePricing {
  const price =
    overrides.price === undefined ? { amount: '19.99', currency: 'USD' } : overrides.price;
  return CoursePricingSchema.parse({
    courseId: FIXTURE_IDS.course,
    price,
    isFree: price !== null && isFreeAmount(price.amount),
    history:
      price === null
        ? []
        : [
            {
              id: fixtureId(0x9c01),
              previousAmount: null,
              amount: price.amount,
              currency: price.currency,
              changedBy: FIXTURE_IDS.instructor,
              changedAt: FIXTURE_NOW,
            },
          ],
    ...overrides,
  });
}

export function makeCartLine(overrides: Partial<CartLine> = {}): CartLine {
  const listAmount = overrides.listAmount ?? '19.99';
  const discountAmount = overrides.discountAmount ?? '0.00';
  return CartLineSchema.parse({
    courseId: FIXTURE_IDS.course,
    slug: 'complete-typescript',
    title: 'Complete TypeScript',
    instructor: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    hasThumbnail: true,
    listAmount,
    discountAmount,
    finalAmount: subtractMoneyFloored(listAmount, discountAmount),
    couponId: discountAmount === '0.00' ? null : FIXTURE_IDS.coupon,
    addedAt: FIXTURE_NOW,
    ...overrides,
  });
}

/** Totals, item count and fingerprint follow `lines` / `unavailable` unless overridden. */
export function makeCartQuote(overrides: Partial<CartQuote> = {}): CartQuote {
  const lines = overrides.lines ?? [makeCartLine()];
  const unavailable = overrides.unavailable ?? [];
  const coupon = overrides.coupon ?? null;
  const totals = {
    listAmount: sumMoney(lines.map((l) => l.listAmount)),
    discountAmount: sumMoney(lines.map((l) => l.discountAmount)),
    totalAmount: sumMoney(lines.map((l) => l.finalAmount)),
  };
  const fingerprint = fixtureFingerprint(
    [...lines.map((l) => `${l.courseId}:${l.finalAmount}`)].sort().join('|') +
      `|${lines.map((l) => l.couponId ?? '').join(',')}|USD`,
  );
  return CartQuoteSchema.parse({
    currency: 'USD',
    lines,
    unavailable,
    coupon,
    totals,
    itemCount: lines.length + unavailable.length,
    fingerprint,
    ...overrides,
  });
}

export function makePurchaseState(overrides: Partial<PurchaseState> = {}): PurchaseState {
  return PurchaseStateSchema.parse({
    courseId: FIXTURE_IDS.course,
    enrolled: false,
    inCart: false,
    isOwner: false,
    forSale: true,
    ...overrides,
  });
}

export function makeCoupon(overrides: Partial<Coupon> = {}): Coupon {
  const discountType = overrides.discountType ?? 'PERCENT';
  const scope = overrides.scope ?? 'COURSE';
  return CouponSchema.parse({
    id: FIXTURE_IDS.coupon,
    scope,
    courseId: scope === 'COURSE' ? FIXTURE_IDS.course : null,
    code: 'LAUNCH50',
    discountType,
    percentOff: discountType === 'PERCENT' ? 50 : null,
    amountOff: discountType === 'AMOUNT' ? '5.00' : null,
    currency: discountType === 'AMOUNT' ? 'USD' : null,
    startsAt: FIXTURE_NOW,
    endsAt: '2026-10-31T12:00:00.000Z',
    maxRedemptions: 100,
    state: 'ACTIVE',
    redemptions: { reserved: 0, consumed: 0 },
    createdBy: scope === 'COURSE' ? FIXTURE_IDS.instructor : FIXTURE_IDS.admin,
    createdAt: FIXTURE_NOW,
    deactivatedAt: null,
    ...overrides,
  });
}

export function makeCheckoutResponse(overrides: Partial<CheckoutResponse> = {}): CheckoutResponse {
  return CheckoutResponseSchema.parse({
    orderId: FIXTURE_IDS.order,
    status: 'PENDING_PAYMENT',
    checkoutUrl: 'http://127.0.0.1:12111/pay/cs_test_fixture',
    ...overrides,
  });
}

/**
 * A buyer's consumption of a course (Phase 5 D8). Default: 1 of 4 lectures completed and
 * 60 of 300 video seconds watched, under the 30% review threshold (no objection).
 */
export function makeCourseConsumption(
  overrides: Partial<CourseConsumption> = {},
): CourseConsumption {
  return CourseConsumptionSchema.parse({
    videoSecondsWatched: 60,
    videoSecondsTotal: 300,
    videoPct: 20,
    completedLectures: 1,
    totalLectures: 4,
    lecturesPct: 25,
    courseCompletedAt: null,
    certificateStatus: null,
    reviewReason: null,
    ...overrides,
  });
}

export function makeOrderLine(overrides: Partial<OrderLine> = {}): OrderLine {
  const listAmount = overrides.listAmount ?? '19.99';
  const discountAmount = overrides.discountAmount ?? '0.00';
  return OrderLineSchema.parse({
    id: FIXTURE_IDS.orderLine,
    lineNo: 1,
    courseId: FIXTURE_IDS.course,
    slug: 'complete-typescript',
    courseTitle: 'Complete TypeScript',
    instructor: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    listAmount,
    discountAmount,
    finalAmount: subtractMoneyFloored(listAmount, discountAmount),
    couponCode: discountAmount === '0.00' ? null : 'LAUNCH50',
    refund: {
      refundId: null,
      status: null,
      refundableUntil: '2026-11-09T12:00:00.000Z',
      eligible: true,
      reason: null,
    },
    consumption: makeCourseConsumption(),
    ...overrides,
  });
}

/** Amount totals follow `lines` unless overridden. Default: a PAID single-line order. */
export function makeOrderDetail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  const lines = overrides.lines ?? [makeOrderLine()];
  const status = overrides.status ?? 'PAID';
  const pending = status === 'PENDING_PAYMENT';
  return OrderDetailSchema.parse({
    id: FIXTURE_IDS.order,
    orderNumber: 1042,
    status,
    currency: 'USD',
    subtotalAmount: sumMoney(lines.map((l) => l.listAmount)),
    discountAmount: sumMoney(lines.map((l) => l.discountAmount)),
    totalAmount: sumMoney(lines.map((l) => l.finalAmount)),
    refundedAmount: sumMoney(
      lines.filter((l) => l.refund.status === 'SUCCEEDED').map((l) => l.finalAmount),
    ),
    placedAt: FIXTURE_NOW,
    paidAt: pending || status === 'EXPIRED' || status === 'CANCELED' ? null : FIXTURE_NOW,
    closedAt: status === 'EXPIRED' || status === 'CANCELED' ? FIXTURE_NOW : null,
    lines,
    payment: { provider: 'STRIPE', status: pending ? 'OPEN' : 'SUCCEEDED' },
    checkoutUrl: pending ? 'http://127.0.0.1:12111/pay/cs_test_fixture' : null,
    ...overrides,
  });
}

export function makeOrderSummary(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return OrderSummarySchema.parse({
    id: FIXTURE_IDS.order,
    orderNumber: 1042,
    status: 'PAID',
    currency: 'USD',
    totalAmount: '19.99',
    lineCount: 1,
    courseTitles: ['Complete TypeScript'],
    placedAt: FIXTURE_NOW,
    paidAt: FIXTURE_NOW,
    ...overrides,
  });
}

/** The summary row of an order detail. */
export function orderSummaryOf(order: OrderDetail): OrderSummary {
  return makeOrderSummary({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    totalAmount: order.totalAmount,
    lineCount: order.lines.length,
    courseTitles: order.lines.map((l) => l.courseTitle),
    placedAt: order.placedAt,
    paidAt: order.paidAt,
  });
}

export function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  const lines = overrides.lines ?? [
    {
      courseTitle: 'Complete TypeScript',
      listAmount: '19.99',
      discountAmount: '0.00',
      finalAmount: '19.99',
      couponCode: null,
    },
  ];
  return ReceiptSchema.parse({
    orderId: FIXTURE_IDS.order,
    orderNumber: 1042,
    issuedAt: FIXTURE_NOW,
    buyer: { displayName: 'Jane Student' },
    currency: 'USD',
    lines,
    subtotalAmount: sumMoney(lines.map((l) => l.listAmount)),
    discountAmount: sumMoney(lines.map((l) => l.discountAmount)),
    totalAmount: sumMoney(lines.map((l) => l.finalAmount)),
    refundedAmount: '0.00',
    paymentProvider: 'STRIPE',
    ...overrides,
  });
}

export function makeRefund(overrides: Partial<Refund> = {}): Refund {
  const status = overrides.status ?? 'APPROVED';
  const approved = status !== 'REQUESTED' && status !== 'REJECTED';
  return RefundSchema.parse({
    id: FIXTURE_IDS.refund,
    orderId: FIXTURE_IDS.order,
    orderLineId: FIXTURE_IDS.orderLine,
    courseId: FIXTURE_IDS.course,
    courseTitle: 'Complete TypeScript',
    amount: '19.99',
    currency: 'USD',
    status,
    initiatedBy: 'STUDENT',
    reasonCode: 'NOT_AS_EXPECTED',
    comment: null,
    rejectionReason: status === 'REJECTED' ? 'The course was mostly watched already.' : null,
    attempt: 1,
    createdAt: FIXTURE_NOW,
    approvedAt: approved ? FIXTURE_NOW : null,
    succeededAt: status === 'SUCCEEDED' ? FIXTURE_NOW : null,
    ...overrides,
  });
}

export function makeAdminRefund(overrides: Partial<AdminRefund> = {}): AdminRefund {
  const { status = 'REQUESTED', ...rest } = overrides;
  return AdminRefundSchema.parse({
    ...makeRefund({ status }),
    userId: FIXTURE_IDS.student,
    requestedBy: FIXTURE_IDS.student,
    providerRefundId: status === 'SUBMITTED' || status === 'SUCCEEDED' ? 're_test_fixture' : null,
    failureCode: status === 'FAILED' ? 'charge_disputed' : null,
    reviewReason: null,
    ...rest,
  });
}

export function makeAdminRefundQueueItem(
  overrides: Partial<AdminRefundQueueItem> = {},
): AdminRefundQueueItem {
  const { status = 'REQUESTED', ...rest } = overrides;
  return AdminRefundQueueItemSchema.parse({
    ...makeAdminRefund({ status }),
    orderNumber: 1042,
    buyer: {
      id: FIXTURE_IDS.student,
      displayName: 'Jane Student',
      email: 'jane@example.com',
      status: 'ACTIVE',
    },
    recentRefundCount: 3,
    consumption: makeCourseConsumption(),
    ...rest,
  });
}

export function makeEnrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  const source = overrides.source ?? 'ORDER';
  const status = overrides.status ?? 'ACTIVE';
  return EnrollmentSchema.parse({
    id: FIXTURE_IDS.enrollment,
    userId: FIXTURE_IDS.student,
    courseId: FIXTURE_IDS.course,
    status,
    source,
    orderLineId: source === 'ORDER' ? FIXTURE_IDS.orderLine : null,
    grantedAt: FIXTURE_NOW,
    revokedAt: status === 'REVOKED' ? FIXTURE_NOW : null,
    revokeReason: status === 'REVOKED' ? 'REFUND' : null,
    ...overrides,
  });
}

export function makeLearningCard(overrides: Partial<LearningCard> = {}): LearningCard {
  return LearningCardSchema.parse({
    enrollmentId: FIXTURE_IDS.enrollment,
    courseId: FIXTURE_IDS.course,
    slug: 'complete-typescript',
    title: 'Complete TypeScript',
    instructor: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    hasThumbnail: true,
    archived: false,
    source: 'ORDER',
    grantedAt: FIXTURE_NOW,
    // Phase 5 (D21): the percent from COURSE_PROGRESS; null only without a reader
    progress: 0,
    ...overrides,
  });
}

export function makeAdminOrderRow(overrides: Partial<AdminOrderRow> = {}): AdminOrderRow {
  return AdminOrderRowSchema.parse({
    id: FIXTURE_IDS.order,
    orderNumber: 1042,
    status: 'PAID',
    currency: 'USD',
    totalAmount: '19.99',
    lineCount: 1,
    buyer: {
      id: FIXTURE_IDS.student,
      displayName: 'Jane Student',
      email: 'jane@example.com',
      status: 'ACTIVE',
    },
    placedAt: FIXTURE_NOW,
    paidAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeAdminOrderLine(overrides: Partial<AdminOrderLine> = {}): AdminOrderLine {
  const listAmount = overrides.listAmount ?? '19.99';
  const discountAmount = overrides.discountAmount ?? '0.00';
  const finalAmount = subtractMoneyFloored(listAmount, discountAmount);
  const bps = overrides.revenueShareBps ?? DEFAULT_REVENUE_SHARE_BPS;
  const instructorShareAmount = instructorShareOf(finalAmount, bps);
  return AdminOrderLineSchema.parse({
    id: FIXTURE_IDS.orderLine,
    lineNo: 1,
    courseId: FIXTURE_IDS.course,
    courseTitle: 'Complete TypeScript',
    instructorId: FIXTURE_IDS.instructor,
    instructor: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    listAmount,
    discountAmount,
    finalAmount,
    couponId: discountAmount === '0.00' ? null : FIXTURE_IDS.coupon,
    couponCode: discountAmount === '0.00' ? null : 'LAUNCH50',
    revenueShareBps: bps,
    instructorShareAmount,
    platformShareAmount: subtractMoneyFloored(finalAmount, instructorShareAmount),
    ...overrides,
  });
}

const NO_TIMELINE_DETAIL = {
  refundId: null,
  cause: null,
  actorId: null,
  actor: null,
  reason: null,
  providerEventId: null,
  providerRefundId: null,
  failureCode: null,
} as const;

/** A refund with its log, as `AdminOrderDetail.refunds` carries it. */
export function makeAdminOrderRefund(overrides: Partial<AdminOrderRefund> = {}): AdminOrderRefund {
  const { status = 'APPROVED', transitions, ...rest } = overrides;
  const base = makeAdminRefund({ status, ...rest });
  return AdminOrderRefundSchema.parse({
    ...base,
    transitions: transitions ?? [
      {
        seq: 1,
        fromStatus: null,
        toStatus: status === 'REQUESTED' || status === 'REJECTED' ? 'REQUESTED' : 'APPROVED',
        actorId: FIXTURE_IDS.student,
        actor: { id: FIXTURE_IDS.student, displayName: 'Jane Student' },
        reason: null,
        providerRefundId: null,
        failureCode: null,
        providerEventId: null,
        occurredAt: FIXTURE_NOW,
      },
    ],
  });
}

export function makeAdminOrderDetail(overrides: Partial<AdminOrderDetail> = {}): AdminOrderDetail {
  const lines = overrides.lines ?? [makeAdminOrderLine()];
  const total = sumMoney(lines.map((l) => l.finalAmount));
  const zeroTotal = total === '0.00';
  return AdminOrderDetailSchema.parse({
    id: FIXTURE_IDS.order,
    orderNumber: 1042,
    status: 'PAID',
    currency: 'USD',
    subtotalAmount: sumMoney(lines.map((l) => l.listAmount)),
    discountAmount: sumMoney(lines.map((l) => l.discountAmount)),
    totalAmount: total,
    refundedAmount: '0.00',
    settlement: zeroTotal ? 'NONE' : 'STRIPE',
    placedAt: FIXTURE_NOW,
    paidAt: FIXTURE_NOW,
    closedAt: null,
    buyer: {
      id: FIXTURE_IDS.student,
      displayName: 'Jane Student',
      email: 'jane@example.com',
      status: 'ACTIVE',
    },
    lines,
    payment: zeroTotal
      ? null
      : {
          id: fixtureId(0xa701),
          provider: 'STRIPE',
          status: 'SUCCEEDED',
          amount: total,
          currency: 'USD',
          checkoutSessionId: 'cs_test_fixture',
          paymentIntentId: 'pi_test_fixture',
          sessionExpiresAt: '2026-10-10T12:30:00.000Z',
          succeededAt: FIXTURE_NOW,
          createdAt: FIXTURE_NOW,
        },
    transitions: [
      {
        id: fixtureId(0x7001),
        fromStatus: null,
        toStatus: zeroTotal ? 'PAID' : 'PENDING_PAYMENT',
        cause: zeroTotal ? 'ZERO_TOTAL' : 'CHECKOUT',
        providerEventId: null,
        actorId: FIXTURE_IDS.student,
        actor: { id: FIXTURE_IDS.student, displayName: 'Jane Student' },
        reason: null,
        occurredAt: FIXTURE_NOW,
      },
      ...(zeroTotal
        ? []
        : [
            {
              id: fixtureId(0x7002),
              fromStatus: 'PENDING_PAYMENT',
              toStatus: 'PAID',
              cause: 'PROVIDER_EVENT',
              providerEventId: 'evt_test_fixture',
              actorId: null,
              actor: null,
              reason: null,
              occurredAt: FIXTURE_NOW,
            },
          ]),
    ],
    refunds: [],
    timeline: [
      {
        ...NO_TIMELINE_DETAIL,
        kind: 'ORDER',
        at: FIXTURE_NOW,
        fromStatus: null,
        toStatus: zeroTotal ? 'PAID' : 'PENDING_PAYMENT',
        cause: zeroTotal ? 'ZERO_TOTAL' : 'CHECKOUT',
        actorId: FIXTURE_IDS.student,
        actor: { id: FIXTURE_IDS.student, displayName: 'Jane Student' },
      },
      ...(zeroTotal
        ? []
        : [
            {
              ...NO_TIMELINE_DETAIL,
              kind: 'ORDER',
              at: FIXTURE_NOW,
              fromStatus: 'PENDING_PAYMENT',
              toStatus: 'PAID',
              cause: 'PROVIDER_EVENT',
              providerEventId: 'evt_test_fixture',
            },
            {
              ...NO_TIMELINE_DETAIL,
              kind: 'PAYMENT',
              at: FIXTURE_NOW,
              fromStatus: null,
              toStatus: 'CREATING',
            },
            {
              ...NO_TIMELINE_DETAIL,
              kind: 'PAYMENT',
              at: FIXTURE_NOW,
              fromStatus: null,
              toStatus: 'SUCCEEDED',
            },
          ]),
    ],
    providerEvents: zeroTotal
      ? []
      : [
          {
            provider: 'STRIPE',
            eventId: 'evt_test_fixture',
            type: 'checkout.session.completed',
            livemode: false,
            objectId: 'cs_test_fixture',
            providerCreatedAt: FIXTURE_NOW,
            receivedAt: FIXTURE_NOW,
            processedAt: FIXTURE_NOW,
            outcome: 'APPLIED',
          },
        ],
    ...overrides,
  });
}

export function makeSalesTotals(overrides: Partial<SalesTotals> = {}): SalesTotals {
  return {
    salesCount: 3,
    refundCount: 0,
    gross: '59.97',
    discounts: '10.00',
    refunded: '0.00',
    net: '49.97',
    instructorShare: '34.98',
    ...overrides,
  };
}

export function makeSalesSummary(overrides: Partial<SalesSummary> = {}): SalesSummary {
  const totals = overrides.totals ?? makeSalesTotals();
  return SalesSummarySchema.parse({
    from: '2026-09-10T00:00:00.000Z',
    to: '2026-10-10T00:00:00.000Z',
    currency: 'USD',
    totals,
    courses: [{ ...totals, courseId: FIXTURE_IDS.course, courseTitle: 'Complete TypeScript' }],
    ...overrides,
  });
}

export function makeRecentSale(overrides: Partial<RecentSale> = {}): RecentSale {
  const finalAmount = overrides.finalAmount ?? '19.99';
  return RecentSaleSchema.parse({
    orderLineId: FIXTURE_IDS.orderLine,
    paidAt: FIXTURE_NOW,
    courseId: FIXTURE_IDS.course,
    courseTitle: 'Complete TypeScript',
    currency: 'USD',
    listAmount: '19.99',
    finalAmount,
    couponCode: null,
    instructorShareAmount: instructorShareOf(finalAmount, DEFAULT_REVENUE_SHARE_BPS),
    refunded: false,
    ...overrides,
  });
}

/** An RFC 7807 body like the api sends. */
export function makeProblem(
  status: number,
  code: ProblemCode,
  extra: Record<string, unknown> = {},
): ProblemDetails {
  return { type: 'about:blank', title: code, status, code, ...extra };
}

export function makeCheckoutInProgressProblem(
  overrides: Partial<CheckoutInProgressProblem> = {},
): CheckoutInProgressProblem {
  return CheckoutInProgressProblemSchema.parse({
    ...makeProblem(409, ErrorCode.CheckoutInProgress),
    orderId: FIXTURE_IDS.order,
    checkoutUrl: 'http://127.0.0.1:12111/pay/cs_test_fixture',
    ...overrides,
  });
}
