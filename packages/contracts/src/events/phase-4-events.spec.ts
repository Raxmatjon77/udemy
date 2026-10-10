import { describe, expect, it } from 'vitest';
import {
  COMMERCE_COUPON_AGGREGATE,
  COMMERCE_COUPON_EVENTS,
  COMMERCE_COURSE_PRICE_AGGREGATE,
  COMMERCE_COURSE_PRICE_EVENTS,
  COMMERCE_ORDER_AGGREGATE,
  COMMERCE_ORDER_EVENTS,
  CouponCreated,
  CouponDeactivated,
  CoursePriceChanged,
  OrderCanceled,
  OrderExpired,
  OrderPaid,
  OrderPaymentMismatch,
  OrderPlaced,
  PaymentDisputed,
  RefundApproved,
  RefundFailed,
  RefundRejected,
  RefundRequested,
  RefundSucceeded,
} from './commerce';
import type { EventDefinition } from './define-event';
import {
  ENROLLMENT_ENROLLMENT_AGGREGATE,
  ENROLLMENT_ENROLLMENT_EVENTS,
  EnrollmentGranted,
  EnrollmentRevoked,
} from './enrollment';

const uuid = (n: number) => `0199c9a1-7d2e-7c4a-9b1e-${String(n).padStart(12, '0')}`;
const orderId = uuid(1);
const userId = uuid(2);
const courseId = uuid(3);
const instructorId = uuid(4);
const lineId = uuid(5);
const refundId = uuid(6);
const couponId = uuid(7);
const enrollmentId = uuid(8);
const adminId = uuid(9);
const at = '2026-10-10T12:00:00.000Z';
const later = '2026-10-20T12:00:00.000Z';

const line = {
  orderLineId: lineId,
  courseId,
  instructorId,
  courseTitle: 'Complete TypeScript',
  listAmount: '19.99',
  discountAmount: '10.00',
  finalAmount: '9.99',
  couponId,
  couponCode: 'LAUNCH50',
  revenueShareBps: 7000,
  instructorShareAmount: '6.99',
  platformShareAmount: '3.00',
};

/** One valid sample payload per event; the keys double as the full event list. */
const samples = new Map<EventDefinition, Record<string, unknown>>([
  [
    OrderPlaced,
    {
      orderId,
      orderNumber: 1042,
      userId,
      currency: 'USD',
      totalAmount: '9.99',
      lineCount: 1,
      placedAt: at,
    },
  ],
  [
    OrderPaid,
    {
      orderId,
      orderNumber: 1042,
      userId,
      currency: 'USD',
      totalAmount: '9.99',
      provider: 'STRIPE',
      paidAt: at,
      lines: [line],
    },
  ],
  [OrderExpired, { orderId, userId, cause: 'PROVIDER_EVENT', expiredAt: at }],
  [OrderCanceled, { orderId, userId, cause: 'USER_CANCEL', canceledAt: at }],
  [
    OrderPaymentMismatch,
    {
      orderId,
      expected: { amount: '9.99', currency: 'USD' },
      received: { amount: '1.00', currency: 'USD' },
      providerEventId: 'evt_1Q2w3E4r',
      detectedAt: at,
    },
  ],
  [
    RefundRequested,
    {
      refundId,
      orderId,
      orderLineId: lineId,
      userId,
      courseId,
      currency: 'USD',
      amount: '9.99',
      reasonCode: 'QUALITY',
      requestedAt: at,
    },
  ],
  [
    RefundApproved,
    {
      refundId,
      orderId,
      orderLineId: lineId,
      initiatedBy: 'STUDENT',
      approvedBy: null,
      approvedAt: at,
    },
  ],
  [
    RefundRejected,
    { refundId, orderId, userId, reason: 'The course was mostly watched.', rejectedAt: at },
  ],
  [
    RefundSucceeded,
    {
      refundId,
      orderId,
      orderLineId: lineId,
      userId,
      courseId,
      instructorId,
      currency: 'USD',
      amount: '9.99',
      instructorShareAmount: '6.99',
      platformShareAmount: '3.00',
      succeededAt: at,
    },
  ],
  [RefundFailed, { refundId, orderId, failureCode: 'charge_disputed', attempt: 1, failedAt: at }],
  [PaymentDisputed, { orderId, paymentIntentId: 'pi_3Q2w3E4r', openedAt: at }],
  [
    CoursePriceChanged,
    {
      courseId,
      previousAmount: null,
      amount: '19.99',
      currency: 'USD',
      changedBy: instructorId,
      changedAt: at,
    },
  ],
  [
    CouponCreated,
    {
      couponId,
      scope: 'COURSE',
      courseId,
      code: 'LAUNCH50',
      discountType: 'PERCENT',
      percentOff: 50,
      amountOff: null,
      currency: null,
      startsAt: at,
      endsAt: later,
      maxRedemptions: 100,
      actorId: instructorId,
      createdAt: at,
    },
  ],
  [
    CouponDeactivated,
    {
      couponId,
      scope: 'COURSE',
      courseId,
      code: 'LAUNCH50',
      actorId: instructorId,
      deactivatedAt: at,
    },
  ],
  [
    EnrollmentGranted,
    {
      enrollmentId,
      userId,
      courseId,
      source: 'ORDER',
      orderLineId: lineId,
      regrant: false,
      grantedAt: at,
    },
  ],
  [
    EnrollmentRevoked,
    {
      enrollmentId,
      userId,
      courseId,
      reason: 'REFUND',
      refundId,
      actorId: null,
      revokedAt: at,
    },
  ],
]);

const allEvents: readonly EventDefinition[] = [
  ...COMMERCE_ORDER_EVENTS,
  ...COMMERCE_COURSE_PRICE_EVENTS,
  ...COMMERCE_COUPON_EVENTS,
  ...ENROLLMENT_ENROLLMENT_EVENTS,
];
const cases = [...samples].map(([event, payload]) => ({ name: event.type, event, payload }));

describe('Phase 4 events', () => {
  it('has a sample for every event in the topic lists', () => {
    expect(new Set(allEvents)).toEqual(new Set(samples.keys()));
    expect(new Set(allEvents.map((e) => e.qualifiedType)).size).toBe(allEvents.length);
    expect(COMMERCE_ORDER_EVENTS.map((e) => e.type)).toEqual([
      'OrderPlaced',
      'OrderPaid',
      'OrderExpired',
      'OrderCanceled',
      'OrderPaymentMismatch',
      'RefundRequested',
      'RefundApproved',
      'RefundRejected',
      'RefundSucceeded',
      'RefundFailed',
      'PaymentDisputed',
    ]);
    expect(COMMERCE_COURSE_PRICE_EVENTS.map((e) => e.type)).toEqual(['CoursePriceChanged']);
    expect(COMMERCE_COUPON_EVENTS.map((e) => e.type)).toEqual([
      'CouponCreated',
      'CouponDeactivated',
    ]);
    expect(ENROLLMENT_ENROLLMENT_EVENTS.map((e) => e.type)).toEqual([
      'EnrollmentGranted',
      'EnrollmentRevoked',
    ]);
  });

  it.each(cases)('$name round-trips through JSON', ({ event, payload }) => {
    const parsed = event.parsePayload(JSON.parse(JSON.stringify(payload)));
    expect(parsed).toEqual(payload);
    expect(event.parsePayload(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(event.version).toBe(1);
    expect(event.qualifiedType).toBe(`${event.type}.v1`);
  });

  it.each(cases)('$name rejects a missing field and a non-ISO timestamp', ({ event, payload }) => {
    for (const key of Object.keys(payload)) {
      const missing = { ...payload };
      delete missing[key];
      expect(event.safeParsePayload(missing).success, key).toBe(false);
    }
    const timestampKey = Object.keys(payload).find((key) => key.endsWith('At'))!;
    expect(event.safeParsePayload({ ...payload, [timestampKey]: '10/10/2026' }).success).toBe(
      false,
    );
  });

  it.each(cases)('$name strips unknown fields (no PII leaks through)', ({ event, payload }) => {
    const parsed = event.parsePayload({
      ...payload,
      email: 'jane@example.com',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test',
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('email');
    expect(parsed).not.toHaveProperty('checkoutUrl');
  });

  it('strips unknown fields inside OrderPaid lines', () => {
    const base = samples.get(OrderPaid)!;
    const parsed = OrderPaid.parsePayload({
      ...base,
      lines: [{ ...line, buyerEmail: 'jane@example.com' }],
    });
    expect(parsed.lines[0]).not.toHaveProperty('buyerEmail');
  });

  it('routes each event to its topic', () => {
    for (const e of COMMERCE_ORDER_EVENTS) expect(e.aggregateType).toBe(COMMERCE_ORDER_AGGREGATE);
    for (const e of COMMERCE_COURSE_PRICE_EVENTS) {
      expect(e.aggregateType).toBe(COMMERCE_COURSE_PRICE_AGGREGATE);
    }
    for (const e of COMMERCE_COUPON_EVENTS) expect(e.aggregateType).toBe(COMMERCE_COUPON_AGGREGATE);
    for (const e of ENROLLMENT_ENROLLMENT_EVENTS) {
      expect(e.aggregateType).toBe(ENROLLMENT_ENROLLMENT_AGGREGATE);
    }
    expect([
      COMMERCE_ORDER_AGGREGATE,
      COMMERCE_COURSE_PRICE_AGGREGATE,
      COMMERCE_COUPON_AGGREGATE,
      ENROLLMENT_ENROLLMENT_AGGREGATE,
    ]).toEqual([
      'commerce.order',
      'commerce.course_price',
      'commerce.coupon',
      'enrollment.enrollment',
    ]);
  });

  it('carries money as decimal strings only', () => {
    const placed = samples.get(OrderPlaced)!;
    for (const totalAmount of [9.99, '9.9', '-1.00', '1e3']) {
      expect(
        OrderPlaced.safeParsePayload({ ...placed, totalAmount }).success,
        String(totalAmount),
      ).toBe(false);
    }
    expect(OrderPlaced.safeParsePayload({ ...placed, currency: 'usd' }).success).toBe(false);
    const paid = samples.get(OrderPaid)!;
    expect(
      OrderPaid.safeParsePayload({ ...paid, lines: [{ ...line, finalAmount: 9.99 }] }).success,
    ).toBe(false);
  });

  it('enforces the enums and bounds', () => {
    const paid = samples.get(OrderPaid)!;
    expect(OrderPaid.safeParsePayload({ ...paid, provider: 'NONE' }).success).toBe(true);
    expect(OrderPaid.safeParsePayload({ ...paid, provider: 'PAYPAL' }).success).toBe(false);
    expect(OrderPaid.safeParsePayload({ ...paid, lines: [] }).success).toBe(false);
    expect(
      OrderPaid.safeParsePayload({ ...paid, lines: [{ ...line, revenueShareBps: 10_001 }] })
        .success,
    ).toBe(false);
    const expired = samples.get(OrderExpired)!;
    expect(OrderExpired.safeParsePayload({ ...expired, cause: 'RECONCILER' }).success).toBe(true);
    expect(OrderExpired.safeParsePayload({ ...expired, cause: 'USER_CANCEL' }).success).toBe(false);
    const canceled = samples.get(OrderCanceled)!;
    expect(OrderCanceled.safeParsePayload({ ...canceled, cause: 'PROVIDER_EVENT' }).success).toBe(
      false,
    );
    const requested = samples.get(RefundRequested)!;
    expect(RefundRequested.safeParsePayload({ ...requested, reasonCode: 'BORED' }).success).toBe(
      false,
    );
    const rejected = samples.get(RefundRejected)!;
    expect(RefundRejected.safeParsePayload({ ...rejected, reason: 'short' }).success).toBe(false);
    const failed = samples.get(RefundFailed)!;
    expect(RefundFailed.safeParsePayload({ ...failed, attempt: 0 }).success).toBe(false);
  });

  it('CouponCreated mirrors the coupons CHECKs', () => {
    const base = samples.get(CouponCreated)!;
    const amount = {
      ...base,
      discountType: 'AMOUNT',
      percentOff: null,
      amountOff: '5.00',
      currency: 'USD',
    };
    expect(CouponCreated.parsePayload(amount)).toEqual(amount);
    expect(CouponCreated.safeParsePayload({ ...amount, currency: null }).success).toBe(false);
    expect(CouponCreated.safeParsePayload({ ...base, amountOff: '5.00' }).success).toBe(false);
    expect(CouponCreated.safeParsePayload({ ...base, courseId: null }).success).toBe(false);
    const platform = { ...base, scope: 'PLATFORM', courseId: null };
    expect(CouponCreated.parsePayload(platform)).toEqual(platform);
    expect(
      CouponCreated.safeParsePayload({ ...amount, scope: 'PLATFORM', courseId: null }).success,
    ).toBe(false);
    const deactivated = samples.get(CouponDeactivated)!;
    expect(CouponDeactivated.safeParsePayload({ ...deactivated, scope: 'PLATFORM' }).success).toBe(
      false,
    );
  });

  it('EnrollmentGranted ties orderLineId to source ORDER', () => {
    const base = samples.get(EnrollmentGranted)!;
    const free = { ...base, source: 'FREE', orderLineId: null, regrant: true };
    expect(EnrollmentGranted.parsePayload(free)).toEqual(free);
    expect(EnrollmentGranted.safeParsePayload({ ...base, orderLineId: null }).success).toBe(false);
    expect(EnrollmentGranted.safeParsePayload({ ...free, orderLineId: lineId }).success).toBe(
      false,
    );
  });

  it('EnrollmentRevoked requires a refundId for REFUND and an actor for ADMIN', () => {
    const base = samples.get(EnrollmentRevoked)!;
    expect(EnrollmentRevoked.safeParsePayload({ ...base, refundId: null }).success).toBe(false);
    const admin = { ...base, reason: 'ADMIN', refundId: null, actorId: adminId };
    expect(EnrollmentRevoked.parsePayload(admin)).toEqual(admin);
    expect(EnrollmentRevoked.safeParsePayload({ ...admin, actorId: null }).success).toBe(false);
  });
});
