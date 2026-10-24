import { readFileSync } from 'node:fs';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as main from '../index.js';
import {
  createCommerceHandlers,
  createCommerceMockStore,
  FIXTURE_IDS,
  fixtureId,
  instructorShareOf,
  makeAdminOrderDetail,
  makeAdminOrderLine,
  makeAdminRefundQueueItem,
  makeCourseConsumption,
  mockCourseConsumption,
  makeCartLine,
  makeCartQuote,
  makeCheckoutInProgressProblem,
  makeCoupon,
  makeCoursePricing,
  makeEnrollment,
  makeLearningCard,
  makeOrderDetail,
  makeOrderLine,
  makeRecentSale,
  makeReceipt,
  makeRefund,
  makeSalesSummary,
} from './index.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, { types: string; default: string }>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
  devDependencies: Record<string, string>;
};

describe('@udemy/contracts/testing', () => {
  it('is a separate ESM subpath, not part of the main entry', () => {
    expect(pkg.exports['./testing']).toEqual({
      types: './dist/testing/index.d.mts',
      default: './dist/testing/index.mjs',
    });
    expect(Object.keys(main)).not.toContain('createCommerceHandlers');
    expect(Object.keys(main)).not.toContain('makeCartQuote');
    expect(pkg.peerDependenciesMeta.msw).toEqual({ optional: true });
    expect(pkg.devDependencies.msw).toBe('2.15.0');
  });
});

describe('fixtures', () => {
  it('derive amounts and totals', () => {
    const line = makeCartLine({ listAmount: '24.99', discountAmount: '5.00' });
    expect(line.finalAmount).toBe('19.99');
    expect(line.couponId).toBe(FIXTURE_IDS.coupon);
    const quote = makeCartQuote({ lines: [line, makeCartLine({ courseId: fixtureId(2) })] });
    expect(quote.totals).toEqual({
      listAmount: '44.98',
      discountAmount: '5.00',
      totalAmount: '39.98',
    });
    expect(quote.itemCount).toBe(2);
    expect(quote.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(makeCartQuote().fingerprint).toBe(makeCartQuote().fingerprint);
    expect(makeCartQuote().fingerprint).not.toBe(quote.fingerprint);
  });

  it('build every view and reject invalid overrides', () => {
    expect(makeCoursePricing({ price: null })).toMatchObject({ isFree: false, history: [] });
    expect(makeCoursePricing({ price: { amount: '0.00', currency: 'USD' } }).isFree).toBe(true);
    expect(makeCoupon({ discountType: 'AMOUNT' })).toMatchObject({
      percentOff: null,
      amountOff: '5.00',
      currency: 'USD',
    });
    expect(makeOrderDetail({ status: 'PENDING_PAYMENT' })).toMatchObject({
      paidAt: null,
      checkoutUrl: expect.stringContaining('/pay/'),
      payment: { status: 'OPEN' },
    });
    expect(
      makeOrderDetail({ lines: [makeOrderLine({ discountAmount: '19.99' })] }).totalAmount,
    ).toBe('0.00');
    expect(makeReceipt().totalAmount).toBe('19.99');
    expect(makeRefund({ status: 'REJECTED' }).rejectionReason).not.toBeNull();
    expect(makeAdminRefundQueueItem({ status: 'FAILED' }).failureCode).toBe('charge_disputed');
    expect(makeAdminRefundQueueItem().consumption.reviewReason).toBeNull();
    expect(makeAdminRefundQueueItem().reviewReason).toBeNull();
    expect(makeOrderLine().consumption).toMatchObject({ lecturesPct: 25, videoPct: 20 });
    expect(makeCourseConsumption({ reviewReason: 'certificate_issued' }).reviewReason).toBe(
      'certificate_issued',
    );
    expect(
      mockCourseConsumption({ ...makeCourseConsumption(), videoSecondsWatched: 91 }),
    ).toMatchObject({
      videoPct: 30,
      reviewReason: 'consumed_video_30',
    });
    expect(() => makeCourseConsumption({ reviewReason: 'consumed_video_101' })).toThrow();
    expect(makeEnrollment({ source: 'FREE' }).orderLineId).toBeNull();
    expect(makeLearningCard().progress).toBe(0);
    expect(makeLearningCard({ progress: null }).progress).toBeNull();
    expect(makeSalesSummary().courses).toHaveLength(1);
    expect(makeRecentSale({ finalAmount: '9.99' }).instructorShareAmount).toBe('6.99');
    expect(makeCheckoutInProgressProblem().code).toBe('checkout_in_progress');
    expect(() => makeOrderDetail({ totalAmount: '19.9' })).toThrow();
    expect(() => makeCoupon({ code: '' })).not.toThrow(); // response codes are not re-validated
    expect(() => makeEnrollment({ status: 'PAUSED' as never })).toThrow();
  });

  it('splits revenue like the DB generated columns (70%, half up)', () => {
    expect(instructorShareOf('9.99', 7000)).toBe('6.99'); // 6.993
    expect(instructorShareOf('0.05', 7000)).toBe('0.04'); // 0.035 -> 0.04
    expect(instructorShareOf('19.99', 7000)).toBe('13.99'); // 13.993
    const line = makeAdminOrderLine({ listAmount: '0.05' });
    expect(line.platformShareAmount).toBe('0.01');
    const zero = makeAdminOrderDetail({ lines: [makeAdminOrderLine({ discountAmount: '19.99' })] });
    expect(zero).toMatchObject({ settlement: 'NONE', payment: null, totalAmount: '0.00' });
  });
});

describe('createCommerceHandlers (MSW)', () => {
  const API = 'http://api.test/api/v1';
  let mock = createCommerceHandlers({ baseUrl: API });
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  function reset(seed: Parameters<typeof createCommerceMockStore>[0] = {}) {
    mock = createCommerceHandlers({ baseUrl: API, store: createCommerceMockStore(seed) });
    server.use(...mock.handlers);
  }

  /** Loose JSON for assertions (every body was already parsed by its contract in the handler). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; type: string | null; json: Json }> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      json: (await response.json()) as Json,
    };
  }

  it('serves public prices with the cache header and omits unpriced ids', async () => {
    reset();
    const response = await fetch(
      `${API}/commerce/prices?courseIds=${FIXTURE_IDS.course},${FIXTURE_IDS.freeCourse},${fixtureId(9)}`,
    );
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.json()).toEqual({
      items: [
        {
          courseId: FIXTURE_IDS.course,
          amount: '19.99',
          currency: 'USD',
          isFree: false,
          slug: 'complete-typescript',
          title: 'Complete TypeScript',
        },
        {
          courseId: FIXTURE_IDS.freeCourse,
          amount: '0.00',
          currency: 'USD',
          isFree: true,
          slug: 'git-basics',
          title: 'Git Basics',
        },
      ],
    });
    expect((await call('GET', '/commerce/prices?courseIds=nope')).status).toBe(400);
  });

  it('runs cart → coupon → checkout → payment → refund', async () => {
    reset({
      coupons: [
        makeCoupon({ startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2999-01-01T00:00:00.000Z' }),
      ],
    });
    expect(
      (await call('PUT', `/me/cart/items/${FIXTURE_IDS.course}`)).json.totals.totalAmount,
    ).toBe('19.99');
    const free = await call('PUT', `/me/cart/items/${FIXTURE_IDS.freeCourse}`);
    expect(free).toMatchObject({ status: 409, json: { code: 'course_is_free' } });
    expect(free.type).toBe('application/problem+json');

    expect((await call('PUT', '/me/cart/coupon', { code: 'nope1' })).json.code).toBe(
      'coupon_invalid',
    );
    const quote = (await call('PUT', '/me/cart/coupon', { code: 'launch50' })).json;
    expect(quote.coupon).toEqual({ code: 'LAUNCH50', applied: true, problem: null });
    expect(quote.lines[0]).toMatchObject({ discountAmount: '10.00', finalAmount: '9.99' });

    const noKey = await call('POST', '/me/checkout', { expectedTotal: '9.99' });
    expect(noKey.json.code).toBe('idempotency_key_required');
    const key = { 'idempotency-key': fixtureId(0xbeef) };
    const changed = await call('POST', '/me/checkout', { expectedTotal: '19.99' }, key);
    expect(changed).toMatchObject({ status: 409, json: { code: 'price_changed' } });
    expect(changed.json.quote.totals.totalAmount).toBe('9.99');

    const checkout = await call('POST', '/me/checkout', { expectedTotal: '9.99' }, key);
    expect(checkout).toMatchObject({ status: 201, json: { status: 'PENDING_PAYMENT' } });
    expect(checkout.json.checkoutUrl).toMatch(/^http:\/\/127\.0\.0\.1:12111\/pay\/cs_test_/);
    // the same key resumes; another key hits the one-open-order rule (D15)
    expect((await call('POST', '/me/checkout', { expectedTotal: '9.99' }, key)).json).toEqual(
      checkout.json,
    );
    const other = await call(
      'POST',
      '/me/checkout',
      { expectedTotal: '9.99' },
      { 'idempotency-key': fixtureId(0xbef0) },
    );
    expect(other.json).toMatchObject({
      code: 'checkout_in_progress',
      orderId: checkout.json.orderId,
      checkoutUrl: checkout.json.checkoutUrl,
    });

    const orderId: string = checkout.json.orderId;
    expect((await call('GET', `/me/orders/${orderId}/receipt`)).json.code).toBe('order_not_paid');
    mock.store.completePayment(orderId);
    const order = (await call('GET', `/me/orders/${orderId}`)).json;
    expect(order).toMatchObject({ status: 'PAID', checkoutUrl: null, totalAmount: '9.99' });
    expect(order.lines[0].refund).toMatchObject({ eligible: true, reason: null });
    expect((await call('GET', '/me/cart')).json).toMatchObject({ itemCount: 0, coupon: null });
    expect((await call('GET', '/me/enrollments')).json.items).toHaveLength(1);
    expect(
      (await call('GET', `/me/purchase-states?courseIds=${FIXTURE_IDS.course}`)).json.items[0],
    ).toMatchObject({ enrolled: true, inCart: false, isOwner: false });
    expect((await call('POST', `/me/orders/${orderId}/cancel`)).json.code).toBe(
      'order_not_cancelable',
    );

    const refund = await call('POST', `/me/orders/${orderId}/refunds`, {
      orderLineId: order.lines[0].id,
      reasonCode: 'QUALITY',
    });
    expect(refund).toMatchObject({ status: 201, json: { status: 'APPROVED', amount: '9.99' } });
    expect((await call('GET', '/me/enrollments')).json.items).toHaveLength(0);
    const again = await call('POST', `/me/orders/${orderId}/refunds`, {
      orderLineId: order.lines[0].id,
      reasonCode: 'QUALITY',
    });
    expect(again).toMatchObject({ status: 409, json: { code: 'refund_already_requested' } });
    mock.store.settleRefund(refund.json.id, 'SUCCEEDED');
    expect((await call('GET', `/me/orders/${orderId}`)).json).toMatchObject({
      status: 'REFUNDED',
      refundedAmount: '9.99',
    });
  });

  it('zero-total orders are PAID at once; cancel releases the coupon', async () => {
    reset({
      coupons: [
        makeCoupon({
          code: 'FREE100',
          percentOff: 100,
          maxRedemptions: 1,
          startsAt: '2020-01-01T00:00:00.000Z',
          endsAt: '2999-01-01T00:00:00.000Z',
        }),
      ],
    });
    await call('PUT', `/me/cart/items/${FIXTURE_IDS.course}`);
    await call('PUT', '/me/cart/coupon', { code: 'FREE100' });
    const paid = await call(
      'POST',
      '/me/checkout',
      { expectedTotal: '0.00' },
      { 'idempotency-key': fixtureId(1) },
    );
    expect(paid.json).toMatchObject({ status: 'PAID', checkoutUrl: null });
    const receipt = (await call('GET', `/me/orders/${paid.json.orderId}/receipt`)).json;
    expect(receipt).toMatchObject({ paymentProvider: 'NONE', totalAmount: '0.00' });
    expect(mock.store.coupons[0]?.redemptions).toEqual({ reserved: 0, consumed: 1 });

    // a pending order can be canceled, which frees the next checkout
    await call('PUT', `/me/cart/items/${FIXTURE_IDS.course2}`);
    const pending = await call(
      'POST',
      '/me/checkout',
      { expectedTotal: '49.99' },
      { 'idempotency-key': fixtureId(2) },
    );
    const canceled = await call('POST', `/me/orders/${pending.json.orderId}/cancel`);
    expect(canceled.json).toMatchObject({ status: 'CANCELED', checkoutUrl: null });
    expect((await call('GET', '/me/orders')).json.items).toHaveLength(2);
  });

  it('enforces the email rule and the minimum charge', async () => {
    reset({ emailVerified: false });
    await call('PUT', `/me/cart/items/${FIXTURE_IDS.course}`);
    const key = { 'idempotency-key': fixtureId(3) };
    expect((await call('POST', '/me/checkout', { expectedTotal: '19.99' }, key)).json.code).toBe(
      'email_not_verified',
    );
    expect(
      (await call('POST', '/me/free-enrollments', { courseId: FIXTURE_IDS.freeCourse })).status,
    ).toBe(201);
    expect(
      (await call('POST', '/me/free-enrollments', { courseId: FIXTURE_IDS.freeCourse })).status,
    ).toBe(200);
    expect(
      (await call('POST', '/me/free-enrollments', { courseId: FIXTURE_IDS.course })).json.code,
    ).toBe('course_not_free');

    reset({
      coupons: [
        makeCoupon({
          discountType: 'AMOUNT',
          amountOff: '19.70',
          startsAt: '2020-01-01T00:00:00.000Z',
          endsAt: '2999-01-01T00:00:00.000Z',
        }),
      ],
    });
    await call('PUT', `/me/cart/items/${FIXTURE_IDS.course}`);
    await call('PUT', '/me/cart/coupon', { code: 'LAUNCH50' });
    expect((await call('POST', '/me/checkout', { expectedTotal: '0.29' }, key)).json.code).toBe(
      'amount_below_minimum',
    );
  });

  it('serves the instructor pricing, coupons and sales of own courses', async () => {
    reset({ viewerId: FIXTURE_IDS.instructor });
    const pricing = `/courses/${FIXTURE_IDS.course}/pricing`;
    expect((await call('PUT', pricing, { amount: '13.37' })).json.code).toBe('price_not_allowed');
    const changed = (await call('PUT', pricing, { amount: '24.99' })).json;
    expect(changed).toMatchObject({ price: { amount: '24.99' }, isFree: false });
    expect(changed.history[0]).toMatchObject({ previousAmount: '19.99', amount: '24.99' });

    const coupons = `/courses/${FIXTURE_IDS.course}/coupons`;
    const body = {
      code: 'launch',
      discountType: 'PERCENT',
      percentOff: 20,
      endsAt: '2999-01-01T00:00:00.000Z',
    };
    const created = await call('POST', coupons, body);
    expect(created).toMatchObject({ status: 201, json: { code: 'LAUNCH', scope: 'COURSE' } });
    expect((await call('POST', coupons, body)).json.code).toBe('coupon_code_taken');
    expect((await call('POST', coupons, { ...body, percentOff: 0 })).status).toBe(400);
    const deactivated = await call('POST', `${coupons}/${created.json.id}/deactivate`);
    expect(deactivated.json.state).toBe('DEACTIVATED');
    expect((await call('GET', coupons)).json.items).toHaveLength(1);

    mock.store.seedPaidOrder(FIXTURE_IDS.student, [FIXTURE_IDS.course, FIXTURE_IDS.course2]);
    const summary = await call(
      'GET',
      '/instructor/sales/summary?from=2000-01-01T00:00:00Z&to=2000-12-31T00:00:00Z',
    );
    expect(summary.json.totals.salesCount).toBe(0);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const live = (await call('GET', `/instructor/sales/summary?from=${from}&to=${to}`)).json;
    expect(live.totals).toMatchObject({ salesCount: 2, gross: '74.98', instructorShare: '52.48' });
    const recent = (await call('GET', '/instructor/sales')).json.items;
    expect(recent).toHaveLength(2);
    expect(JSON.stringify(recent)).not.toContain('jane@example.com');

    // foreign courses are 404 (policy)
    reset({ viewerId: FIXTURE_IDS.student });
    expect((await call('GET', pricing)).status).toBe(404);
  });

  it('serves the admin orders, refund queue, coupons and enrollments', async () => {
    reset({ viewerId: FIXTURE_IDS.admin });
    const order = mock.store.seedPaidOrder(FIXTURE_IDS.student, [FIXTURE_IDS.course]);
    const rows = (await call('GET', `/admin/orders?q=${order.orderNumber}`)).json.items;
    expect(rows).toHaveLength(1);
    expect(rows[0].buyer.email).toBe('jane@example.com');
    const detail = (await call('GET', `/admin/orders/${order.id}`)).json;
    expect(detail.transitions.map((t: { toStatus: string }) => t.toStatus)).toEqual([
      'PENDING_PAYMENT',
      'PAID',
    ]);
    expect(detail.providerEvents[0]).toMatchObject({ outcome: 'APPLIED', livemode: false });

    const lineId = detail.lines[0].id;
    const refunds = await call('POST', `/admin/orders/${order.id}/refunds`, {
      orderLineIds: [lineId],
      reason: 'Customer support goodwill',
    });
    expect(refunds).toMatchObject({
      status: 201,
      json: [{ status: 'APPROVED', initiatedBy: 'ADMIN' }],
    });
    mock.store.settleRefund(refunds.json[0].id, 'FAILED');
    const queue = (await call('GET', '/admin/refunds?status=FAILED')).json.items;
    expect(queue).toHaveLength(1);
    const retried = await call('POST', `/admin/refunds/${queue[0].id}/retry`, {});
    expect(retried.json).toMatchObject({ status: 'APPROVED', attempt: 2 });
    expect(
      (await call('POST', `/admin/refunds/${queue[0].id}/reject`, { reason: 'Not allowed here' }))
        .json.code,
    ).toBe('invalid_state_transition');

    const coupon = await call('POST', '/admin/coupons', {
      code: 'blackfriday',
      percentOff: 30,
      endsAt: '2999-01-01T00:00:00.000Z',
    });
    expect(coupon.json).toMatchObject({ scope: 'PLATFORM', courseId: null, code: 'BLACKFRIDAY' });

    const grant = await call('POST', '/admin/enrollments', {
      userId: FIXTURE_IDS.student,
      courseId: FIXTURE_IDS.course2,
      reason: 'Goodwill grant for support',
    });
    expect(grant).toMatchObject({ status: 201, json: { source: 'ADMIN', status: 'ACTIVE' } });
    const enrollments = (await call('GET', `/admin/users/${FIXTURE_IDS.student}/enrollments`)).json;
    expect(enrollments.items.map((e: { status: string }) => e.status).sort()).toEqual([
      'ACTIVE',
      'REVOKED',
    ]);
    const revoked = await call('POST', `/admin/enrollments/${grant.json.id}/revoke`, {
      reason: 'Granted by mistake',
    });
    expect(revoked.json).toMatchObject({ status: 'REVOKED', revokeReason: 'ADMIN' });
  });

  it('P4-T16 additions: buyer-email search, timeline with actor names, refund logs, every queue status, PAYMENT_REVIEW', async () => {
    reset({ viewerId: FIXTURE_IDS.admin });
    const order = mock.store.seedPaidOrder(FIXTURE_IDS.student, [FIXTURE_IDS.course]);
    expect((await call('GET', '/admin/orders?buyerEmail=JANE@')).json.items).toHaveLength(1);
    expect((await call('GET', '/admin/orders?buyerEmail=nobody@')).json.items).toHaveLength(0);
    expect((await call('GET', '/admin/orders?buyerEmail=ja')).status).toBe(400);

    const lineId = (await call('GET', `/admin/orders/${order.id}`)).json.lines[0].id;
    const [refund] = (
      await call('POST', `/admin/orders/${order.id}/refunds`, {
        orderLineIds: [lineId],
        reason: 'Customer support goodwill',
      })
    ).json;
    expect(refund).toMatchObject({ reasonCode: 'ADMIN_DISCRETION', comment: null });
    mock.store.settleRefund(refund.id, 'SUCCEEDED');
    const detail = (await call('GET', `/admin/orders/${order.id}`)).json;
    expect(detail.refunds[0].transitions.map((t: { toStatus: string }) => t.toStatus)).toEqual([
      'APPROVED',
      'SUCCEEDED',
    ]);
    expect(detail.refunds[0].transitions[0]).toMatchObject({
      actorId: FIXTURE_IDS.admin,
      reason: 'Customer support goodwill',
    });
    expect(detail.refunds[0].transitions[0].actor).not.toBeNull();
    expect(detail.transitions[0].actor).toMatchObject({ id: FIXTURE_IDS.student });
    expect(detail.timeline.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['ORDER', 'PAYMENT', 'REFUND']),
    );
    const succeeded = (await call('GET', '/admin/refunds?status=SUCCEEDED')).json.items;
    expect(succeeded.map((i: { id: string }) => i.id)).toEqual([refund.id]);
    expect(succeeded[0].recentRefundCount).toBe(0); // ADMIN refunds never count

    const review = mock.store.seedPaidOrder(FIXTURE_IDS.student, [FIXTURE_IDS.course2]);
    expect(
      (
        await call('POST', `/admin/orders/${review.id}/accept-payment`, {
          reason: 'Not under review',
        })
      ).status,
    ).toBe(409);
  });
  it('paginates lists like the api: limit, an opaque nextCursor, 422 for a foreign cursor', async () => {
    reset({ viewerId: FIXTURE_IDS.admin });
    for (const courseId of [FIXTURE_IDS.course, FIXTURE_IDS.course2, FIXTURE_IDS.course]) {
      mock.store.seedPaidOrder(FIXTURE_IDS.student, [courseId]);
    }
    const first = (await call('GET', '/admin/orders?limit=2')).json;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await call('GET', `/admin/orders?limit=2&cursor=${first.nextCursor}`)).json;
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items).toHaveLength(1);
    const ids = [...first.items, ...second.items].map((o: { id: string }) => o.id);
    expect(new Set(ids).size).toBe(3);
    expect((await call('GET', '/admin/orders?cursor=bogus')).status).toBe(422);
    expect((await call('GET', '/admin/orders?limit=101')).status).toBe(400);
  });

  it('rate-limits like the api: 429 rate_limited with Retry-After', async () => {
    let now = Date.parse('2026-10-20T10:00:00.000Z');
    reset({
      now: () => new Date(now),
      rateLimits: { couponApply: { limit: 2, windowMs: 60_000 } },
    });
    for (let i = 0; i < 2; i++) {
      expect((await call('PUT', '/me/cart/coupon', { code: 'NOPE1' })).status).toBe(422);
    }
    const response = await fetch(`${API}/me/cart/coupon`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'NOPE1' }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    now += 60_000; // a new window
    expect((await call('PUT', '/me/cart/coupon', { code: 'NOPE1' })).status).toBe(422);
  });
});
