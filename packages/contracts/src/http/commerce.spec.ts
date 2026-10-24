import { describe, expect, it } from 'vitest';
import { SignedMoneyAmountSchema } from '../money/money';
import {
  AcceptPaymentRequestSchema,
  ADMIN_REFUND_FILTER_STATUSES,
  AdminOrderDetailSchema,
  AdminOrdersQuerySchema,
  AdminOrderTimelineEntrySchema,
  AdminRefundOrderLinesRequestSchema,
  AdminRefundsQuerySchema,
  OrderTransitionSchema,
  REFUND_QUEUE_STATUSES,
  RefundTransitionSchema,
  RejectRefundRequestSchema,
} from './commerce-admin';
import {
  ApplyCouponRequestSchema,
  CartQuoteSchema,
  MergeGuestCartRequestSchema,
  MergeGuestCartResponseSchema,
  PurchaseStatesQuerySchema,
} from './commerce-cart';
import {
  CheckoutUrlSchema,
  CouponCodeSchema,
  INSTRUCTOR_SHARE_BPS,
  REFUND_REVIEW_LOOKBACK_DAYS,
  REFUND_REVIEW_THRESHOLD,
  STUDENT_REFUND_REASON_CODES,
} from './commerce-common';
import {
  COUPON_LIMITS,
  CouponSchema,
  CreateCourseCouponRequestSchema,
  CreatePlatformCouponRequestSchema,
} from './commerce-coupons';
import {
  CheckoutHeadersSchema,
  CheckoutInProgressProblemSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  CourseConsumptionSchema,
  OrderDetailSchema,
  OrderLineSchema,
  PriceChangedProblemSchema,
  REFUND_REVIEW_CONSUMED_PCT,
  RefundReviewReasonSchema,
  RequestRefundRequestSchema,
} from './commerce-orders';
import {
  CoursePricingSchema,
  PUBLIC_PRICES_MAX_IDS,
  PublicPricesQuerySchema,
  SetCoursePriceRequestSchema,
} from './commerce-pricing';
import { SalesSummaryQuerySchema } from './commerce-sales';
import { StripeWebhookHeadersSchema, WebhookAckSchema } from './commerce-webhook';
import {
  AdminGrantEnrollmentRequestSchema,
  FreeEnrollmentRequestSchema,
  LearningCardSchema,
  MyLearningQuerySchema,
} from './enrollment';

const uuid = (n: number) => `0199c9a1-7d2e-7c4a-9b1e-${String(n).padStart(12, '0')}`;
const id = uuid(1);
const at = '2026-10-10T12:00:00.000Z';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const quote = {
  currency: 'USD',
  lines: [
    {
      courseId: id,
      slug: 'complete-typescript',
      title: 'Complete TypeScript',
      instructor: { id: uuid(2), displayName: 'Ada' },
      hasThumbnail: true,
      listAmount: '19.99',
      discountAmount: '10.00',
      finalAmount: '9.99',
      couponId: uuid(3),
      addedAt: at,
    },
  ],
  unavailable: [{ courseId: uuid(4), title: null, reason: 'course_not_for_sale', addedAt: at }],
  coupon: { code: 'LAUNCH50', applied: true, problem: null },
  totals: { listAmount: '19.99', discountAmount: '10.00', totalAmount: '9.99' },
  itemCount: 2,
  fingerprint: 'a'.repeat(64),
};

describe('pricing', () => {
  it('accepts a decimal amount and leaves the tier check to the api', () => {
    expect(SetCoursePriceRequestSchema.parse({ amount: '13.37' })).toEqual({ amount: '13.37' });
    expect(ok(SetCoursePriceRequestSchema, { amount: '0.00' })).toBe(true);
    expect(ok(SetCoursePriceRequestSchema, { amount: 19.99 })).toBe(false);
    expect(ok(SetCoursePriceRequestSchema, { amount: '19.9' })).toBe(false);
  });

  it('describes an unpriced course', () => {
    expect(ok(CoursePricingSchema, { courseId: id, price: null, isFree: false, history: [] })).toBe(
      true,
    );
  });

  it('public prices take 1–48 unique ids, comma separated or repeated', () => {
    expect(PublicPricesQuerySchema.parse({ courseIds: `${uuid(1)},${uuid(2)}` })).toEqual({
      courseIds: [uuid(1), uuid(2)],
    });
    expect(
      PublicPricesQuerySchema.parse({ courseIds: [uuid(1), `${uuid(2)},${uuid(3)}`] }),
    ).toEqual({ courseIds: [uuid(1), uuid(2), uuid(3)] });
    const max = Array.from({ length: PUBLIC_PRICES_MAX_IDS }, (_, i) => uuid(i + 1)).join(',');
    expect(ok(PublicPricesQuerySchema, { courseIds: max })).toBe(true);
    expect(ok(PublicPricesQuerySchema, { courseIds: `${max},${uuid(99)}` })).toBe(false);
    expect(ok(PublicPricesQuerySchema, { courseIds: '' })).toBe(false);
    expect(ok(PublicPricesQuerySchema, { courseIds: `${id},${id}` })).toBe(false);
    expect(ok(PublicPricesQuerySchema, { courseIds: 'nope' })).toBe(false);
  });
});

describe('cart', () => {
  it('parses a quote with unavailable lines and a coupon', () => {
    expect(CartQuoteSchema.parse(quote)).toEqual(quote);
    expect(ok(CartQuoteSchema, { ...quote, fingerprint: 'abc' })).toBe(false);
    expect(
      ok(CartQuoteSchema, { ...quote, coupon: { code: 'X1Y2', applied: false, problem: 'nope' } }),
    ).toBe(false);
  });

  it('merges at most 20 unique guest ids', () => {
    const ids = Array.from({ length: 20 }, (_, i) => uuid(i + 1));
    expect(ok(MergeGuestCartRequestSchema, { courseIds: ids })).toBe(true);
    expect(ok(MergeGuestCartRequestSchema, { courseIds: [...ids, uuid(21)] })).toBe(false);
    expect(ok(MergeGuestCartRequestSchema, { courseIds: [] })).toBe(false);
    expect(ok(MergeGuestCartRequestSchema, { courseIds: [id, id] })).toBe(false);
    expect(
      ok(MergeGuestCartResponseSchema, {
        quote,
        added: [id],
        skipped: [
          { courseId: uuid(5), reason: 'already_enrolled' },
          { courseId: uuid(6), reason: 'cart_full' },
        ],
      }),
    ).toBe(true);
  });

  it('normalises coupon codes to uppercase and checks the D5 pattern', () => {
    expect(ApplyCouponRequestSchema.parse({ code: ' launch-50 ' })).toEqual({ code: 'LAUNCH-50' });
    for (const code of ['abc', 'x'.repeat(21), 'LAUNCH 50', 'LAUNCH!', 'ÄBCD']) {
      expect(ok(CouponCodeSchema, code), code).toBe(false);
    }
    expect(ok(CouponCodeSchema, 'A_B-1')).toBe(true);
  });

  it('purchase states take up to 48 ids', () => {
    expect(ok(PurchaseStatesQuerySchema, { courseIds: id })).toBe(true);
    expect(ok(PurchaseStatesQuerySchema, {})).toBe(false);
  });
});

describe('coupons', () => {
  const base = { code: 'launch50', startsAt: at, endsAt: '2026-10-20T12:00:00.000Z' };

  it('creates PERCENT and AMOUNT course coupons', () => {
    expect(
      CreateCourseCouponRequestSchema.parse({ ...base, discountType: 'PERCENT', percentOff: 50 }),
    ).toEqual({ ...base, code: 'LAUNCH50', discountType: 'PERCENT', percentOff: 50 });
    expect(
      ok(CreateCourseCouponRequestSchema, { ...base, discountType: 'AMOUNT', amountOff: '5.00' }),
    ).toBe(true);
    expect(
      ok(CreateCourseCouponRequestSchema, { ...base, discountType: 'AMOUNT', amountOff: '0.00' }),
    ).toBe(false);
    expect(
      ok(CreateCourseCouponRequestSchema, { ...base, discountType: 'AMOUNT', percentOff: 10 }),
    ).toBe(false);
    for (const percentOff of [0, 101, 12.5]) {
      expect(
        ok(CreateCourseCouponRequestSchema, { ...base, discountType: 'PERCENT', percentOff }),
        String(percentOff),
      ).toBe(false);
    }
  });

  it('bounds the course coupon window to 1–31 days', () => {
    const percent = { ...base, discountType: 'PERCENT', percentOff: 10 };
    const plusDays = (days: number) => new Date(Date.parse(at) + days * 86_400_000).toISOString();
    expect(ok(CreateCourseCouponRequestSchema, { ...percent, endsAt: plusDays(1) })).toBe(true);
    expect(ok(CreateCourseCouponRequestSchema, { ...percent, endsAt: plusDays(31) })).toBe(true);
    expect(ok(CreateCourseCouponRequestSchema, { ...percent, endsAt: plusDays(32) })).toBe(false);
    expect(ok(CreateCourseCouponRequestSchema, { ...percent, endsAt: plusDays(0.5) })).toBe(false);
    expect(ok(CreateCourseCouponRequestSchema, { ...percent, endsAt: at })).toBe(false);
    // without startsAt ("now") the window is checked by the api
    expect(
      ok(CreateCourseCouponRequestSchema, {
        ...percent,
        startsAt: undefined,
        endsAt: plusDays(60),
      }),
    ).toBe(true);
    expect(
      ok(CreateCourseCouponRequestSchema, {
        ...percent,
        maxRedemptions: COUPON_LIMITS.maxRedemptions + 1,
      }),
    ).toBe(false);
  });

  it('platform coupons are PERCENT only with a window of up to 90 days', () => {
    expect(CreatePlatformCouponRequestSchema.parse({ ...base, percentOff: 20 })).toEqual({
      ...base,
      code: 'LAUNCH50',
      discountType: 'PERCENT',
      percentOff: 20,
    });
    expect(
      ok(CreatePlatformCouponRequestSchema, {
        ...base,
        discountType: 'AMOUNT',
        amountOff: '5.00',
      }),
    ).toBe(false);
    expect(
      ok(CreatePlatformCouponRequestSchema, {
        ...base,
        percentOff: 20,
        endsAt: '2027-01-09T12:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('parses a coupon view', () => {
    expect(
      ok(CouponSchema, {
        id,
        scope: 'PLATFORM',
        courseId: null,
        code: 'BLACKFRIDAY',
        discountType: 'PERCENT',
        percentOff: 30,
        amountOff: null,
        currency: null,
        startsAt: at,
        endsAt: at,
        maxRedemptions: null,
        state: 'EXHAUSTED',
        redemptions: { reserved: 1, consumed: 2 },
        createdBy: id,
        createdAt: at,
        deactivatedAt: null,
      }),
    ).toBe(true);
  });
});

describe('checkout', () => {
  it('requires a UUID Idempotency-Key and an expected total', () => {
    expect(ok(CheckoutHeadersSchema, { 'idempotency-key': id })).toBe(true);
    expect(ok(CheckoutHeadersSchema, { 'idempotency-key': 'retry-1' })).toBe(false);
    expect(ok(CheckoutRequestSchema, { expectedTotal: '9.99' })).toBe(true);
    expect(ok(CheckoutRequestSchema, { expectedTotal: 9.99 })).toBe(false);
  });

  it('answers PAID with no URL or PENDING_PAYMENT with an http(s) URL', () => {
    expect(ok(CheckoutResponseSchema, { orderId: id, status: 'PAID', checkoutUrl: null })).toBe(
      true,
    );
    expect(
      ok(CheckoutResponseSchema, {
        orderId: id,
        status: 'PENDING_PAYMENT',
        checkoutUrl: 'http://127.0.0.1:12111/pay/cs_test_1',
      }),
    ).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/pay/cs_test_1']) {
      expect(ok(CheckoutUrlSchema, url), url).toBe(false);
    }
  });

  it('checkout_in_progress carries orderId and checkoutUrl', () => {
    const problem = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'checkout_in_progress',
      orderId: id,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    };
    expect(CheckoutInProgressProblemSchema.parse(problem)).toEqual(problem);
    expect(ok(CheckoutInProgressProblemSchema, { ...problem, checkoutUrl: null })).toBe(true);
    expect(ok(CheckoutInProgressProblemSchema, { ...problem, orderId: undefined })).toBe(false);
    expect(ok(CheckoutInProgressProblemSchema, { ...problem, code: 'price_changed' })).toBe(false);
  });

  it('price_changed carries the fresh quote', () => {
    const problem = { type: 'about:blank', title: 'Conflict', status: 409, code: 'price_changed' };
    expect(ok(PriceChangedProblemSchema, { ...problem, quote })).toBe(true);
    expect(ok(PriceChangedProblemSchema, problem)).toBe(false);
  });
});

describe('orders and refunds', () => {
  const line = {
    id,
    lineNo: 1,
    courseId: id,
    slug: 'complete-typescript',
    courseTitle: 'Complete TypeScript',
    instructor: null,
    listAmount: '19.99',
    discountAmount: '0.00',
    finalAmount: '19.99',
    couponCode: null,
    refund: {
      refundId: null,
      status: null,
      refundableUntil: at,
      eligible: true,
      reason: null,
    },
    consumption: null,
  };
  const order = {
    id,
    orderNumber: 1042,
    status: 'PAID',
    currency: 'USD',
    subtotalAmount: '19.99',
    discountAmount: '0.00',
    totalAmount: '19.99',
    refundedAmount: '0.00',
    placedAt: at,
    paidAt: at,
    closedAt: null,
    lines: [line],
    payment: { provider: 'STRIPE', status: 'SUCCEEDED' },
    checkoutUrl: null,
  };

  it('parses an order detail', () => {
    expect(OrderDetailSchema.parse(order)).toEqual(order);
    expect(ok(OrderDetailSchema, { ...order, lines: [] })).toBe(false);
    expect(ok(OrderDetailSchema, { ...order, status: 'SHIPPED' })).toBe(false);
  });

  it('Phase 5: order lines carry the buyer consumption (or null); review reasons are closed', () => {
    const consumption = {
      videoSecondsWatched: 450,
      videoSecondsTotal: 1000,
      videoPct: 45,
      completedLectures: 1,
      totalLectures: 4,
      lecturesPct: 25,
      courseCompletedAt: null,
      certificateStatus: null,
      reviewReason: 'consumed_video_45',
    };
    expect(CourseConsumptionSchema.parse(consumption)).toEqual(consumption);
    expect(OrderLineSchema.parse({ ...line, consumption }).consumption).toEqual(consumption);
    expect(ok(OrderLineSchema, { ...line, consumption: undefined })).toBe(false);
    expect(ok(CourseConsumptionSchema, { ...consumption, videoPct: 101 })).toBe(false);
    expect(ok(CourseConsumptionSchema, { ...consumption, certificateStatus: 'PENDING' })).toBe(
      false,
    );
    for (const reason of ['certificate_issued', 'consumed_video_31', 'consumed_lectures_100']) {
      expect(ok(RefundReviewReasonSchema, reason)).toBe(true);
    }
    for (const reason of ['consumed_video_101', 'consumed_video_07', 'consumed_quiz_50', '']) {
      expect(ok(RefundReviewReasonSchema, reason)).toBe(false);
    }
    expect(REFUND_REVIEW_CONSUMED_PCT).toBe(30);
  });

  it('students pick from the student reasons only', () => {
    expect(STUDENT_REFUND_REASON_CODES).toEqual([
      'NOT_AS_EXPECTED',
      'QUALITY',
      'ACCIDENTAL_PURCHASE',
      'OTHER',
    ]);
    expect(ok(RequestRefundRequestSchema, { orderLineId: id, reasonCode: 'QUALITY' })).toBe(true);
    expect(
      ok(RequestRefundRequestSchema, { orderLineId: id, reasonCode: 'DUPLICATE_PURCHASE' }),
    ).toBe(false);
    expect(
      ok(RequestRefundRequestSchema, {
        orderLineId: id,
        reasonCode: 'OTHER',
        comment: 'c'.repeat(1001),
      }),
    ).toBe(false);
  });

  it('admin money actions require a 10–2000 reason', () => {
    expect(
      ok(AdminRefundOrderLinesRequestSchema, { orderLineIds: [id], reason: 'Customer support' }),
    ).toBe(true);
    expect(ok(AdminRefundOrderLinesRequestSchema, { orderLineIds: [id], reason: 'short' })).toBe(
      false,
    );
    expect(
      ok(AdminRefundOrderLinesRequestSchema, { orderLineIds: [], reason: 'Customer support' }),
    ).toBe(false);
    expect(ok(AcceptPaymentRequestSchema, { reason: 'r'.repeat(2001) })).toBe(false);
    expect(ok(RejectRefundRequestSchema, {})).toBe(false);
  });
});

describe('admin queries', () => {
  it('searches orders by number, status and range', () => {
    expect(AdminOrdersQuerySchema.parse({ q: '1042', status: '', from: '', limit: '10' })).toEqual({
      q: 1042,
      limit: 10,
    });
    expect(ok(AdminOrdersQuerySchema, { q: '#1042' })).toBe(false);
    expect(AdminOrdersQuerySchema.parse({ buyerEmail: '  jane@ ' }).buyerEmail).toBe('jane@');
    expect(AdminOrdersQuerySchema.parse({ buyerEmail: '' }).buyerEmail).toBeUndefined();
    expect(ok(AdminOrdersQuerySchema, { buyerEmail: 'ja' })).toBe(false);
    expect(ok(AdminOrdersQuerySchema, { buyerEmail: 'a'.repeat(255) })).toBe(false);
    expect(ok(AdminOrdersQuerySchema, { q: '0' })).toBe(false);
    expect(
      ok(AdminOrdersQuerySchema, { from: '2026-10-10T00:00:00Z', to: '2026-10-09T00:00:00Z' }),
    ).toBe(false);
  });

  it('defaults the refund queue to REQUESTED', () => {
    expect(AdminRefundsQuerySchema.parse({})).toEqual({ limit: 20, status: 'REQUESTED' });
    expect(AdminRefundsQuerySchema.parse({ status: 'FAILED' }).status).toBe('FAILED');
    // P4-T16: every refund status is filterable; REQUESTED / FAILED stay the work queues.
    for (const status of ADMIN_REFUND_FILTER_STATUSES) {
      expect(AdminRefundsQuerySchema.parse({ status }).status).toBe(status);
    }
    expect(ok(AdminRefundsQuerySchema, { status: 'DONE' })).toBe(false);
    expect([...REFUND_QUEUE_STATUSES]).toEqual(['REQUESTED', 'FAILED']);
  });

  it('a zero-total order has no payment row', () => {
    const detail = {
      id,
      orderNumber: 7,
      status: 'PAID',
      currency: 'USD',
      subtotalAmount: '19.99',
      discountAmount: '19.99',
      totalAmount: '0.00',
      refundedAmount: '0.00',
      settlement: 'NONE',
      placedAt: at,
      paidAt: at,
      closedAt: null,
      buyer: null,
      lines: [
        {
          id,
          lineNo: 1,
          courseId: id,
          courseTitle: 'Complete TypeScript',
          instructorId: id,
          instructor: null,
          listAmount: '19.99',
          discountAmount: '19.99',
          finalAmount: '0.00',
          couponId: id,
          couponCode: 'FREE100',
          revenueShareBps: 7000,
          instructorShareAmount: '0.00',
          platformShareAmount: '0.00',
        },
      ],
      payment: null,
      transitions: [],
      refunds: [],
      providerEvents: [],
      timeline: [],
    };
    expect(AdminOrderDetailSchema.parse(detail)).toEqual(detail);
  });

  it('timeline entries, refund transitions and actor names (P4-T16)', () => {
    const entry = {
      kind: 'REFUND',
      at,
      refundId: id,
      fromStatus: 'APPROVED',
      toStatus: 'SUCCEEDED',
      cause: null,
      actorId: null,
      actor: null,
      reason: null,
      providerEventId: 'evt_1',
      providerRefundId: 're_1',
      failureCode: null,
    };
    expect(AdminOrderTimelineEntrySchema.parse(entry)).toEqual(entry);
    expect(ok(AdminOrderTimelineEntrySchema, { ...entry, toStatus: 'NOPE' })).toBe(false);
    expect(ok(AdminOrderTimelineEntrySchema, { ...entry, kind: 'COUPON' })).toBe(false);
    const transition = {
      seq: 2,
      fromStatus: 'REQUESTED',
      toStatus: 'REJECTED',
      actorId: id,
      actor: { id, displayName: 'Admin' },
      reason: 'Mostly watched already.',
      providerRefundId: null,
      failureCode: null,
      providerEventId: null,
      occurredAt: at,
    };
    expect(RefundTransitionSchema.parse(transition)).toEqual(transition);
    expect(ok(RefundTransitionSchema, { ...transition, seq: 0 })).toBe(false);
    expect(
      ok(OrderTransitionSchema, {
        id,
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        cause: 'CHECKOUT',
        providerEventId: null,
        actorId: id,
        reason: null,
        occurredAt: at,
      }),
    ).toBe(false); // `actor` is required (null when unknown)
  });

  it('signed money for sales report figures; the share constants', () => {
    for (const v of ['0.00', '13.99', '-4.99', '-0.01', '-1000.00']) {
      expect(ok(SignedMoneyAmountSchema, v), v).toBe(true);
    }
    for (const v of ['-0.00', '01.00', '-01.00', '1.5', '+1.00', '']) {
      expect(ok(SignedMoneyAmountSchema, v), v).toBe(false);
    }
    expect(INSTRUCTOR_SHARE_BPS).toBe(7000);
    expect([REFUND_REVIEW_THRESHOLD, REFUND_REVIEW_LOOKBACK_DAYS]).toEqual([3, 90]);
  });

  it('sales summary ranges are ordered and at most 366 days', () => {
    expect(
      ok(SalesSummaryQuerySchema, { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }),
    ).toBe(true);
    expect(
      ok(SalesSummaryQuerySchema, { from: '2026-01-01T00:00:00Z', to: '2027-01-03T00:00:00Z' }),
    ).toBe(false);
    expect(ok(SalesSummaryQuerySchema, { from: at, to: at })).toBe(false);
    expect(ok(SalesSummaryQuerySchema, {})).toBe(false);
  });
});

describe('enrollment', () => {
  it('free enrolment takes a course id', () => {
    expect(ok(FreeEnrollmentRequestSchema, { courseId: id })).toBe(true);
    expect(ok(FreeEnrollmentRequestSchema, {})).toBe(false);
  });

  it('my learning pages are at most 24', () => {
    expect(MyLearningQuerySchema.parse({})).toEqual({ limit: 24 });
    expect(ok(MyLearningQuerySchema, { limit: '25' })).toBe(false);
    expect(
      ok(LearningCardSchema, {
        enrollmentId: id,
        courseId: id,
        slug: 'complete-typescript',
        title: 'Complete TypeScript',
        instructor: null,
        hasThumbnail: false,
        archived: true,
        source: 'FREE',
        grantedAt: at,
        progress: null,
      }),
    ).toBe(true);
  });

  it('admin grants need a reason', () => {
    expect(
      ok(AdminGrantEnrollmentRequestSchema, { userId: id, courseId: id, reason: 'Goodwill grant' }),
    ).toBe(true);
    expect(ok(AdminGrantEnrollmentRequestSchema, { userId: id, courseId: id })).toBe(false);
  });
});

describe('webhook', () => {
  it('describes only the Stripe-Signature header and the ack', () => {
    expect(
      ok(StripeWebhookHeadersSchema, { 'stripe-signature': 't=1760097600,v1=abc', host: 'x' }),
    ).toBe(true);
    expect(ok(StripeWebhookHeadersSchema, {})).toBe(false);
    expect(ok(StripeWebhookHeadersSchema, { 'stripe-signature': 'v1=abc' })).toBe(false);
    expect(WebhookAckSchema.parse({ received: true })).toEqual({ received: true });
    expect(ok(WebhookAckSchema, { received: false })).toBe(false);
  });
});
