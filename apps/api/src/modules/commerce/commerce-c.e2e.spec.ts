// Must stay the first import: AppModule validates process.env when it is imported.
import { COMMERCE_C_E2E_ENV } from './testing/apply-commerce-c-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  AdminOrderDetailSchema,
  AdminOrderPageSchema,
  AdminRefundOrderLinesResponseSchema,
  AdminRefundQueuePageSchema,
  type AuthResult,
  CartQuoteSchema,
  CheckoutResponseSchema,
  ErrorCode,
  OrderDetailSchema,
  RecentSalePageSchema,
  RefundDecisionResponseSchema,
  RefundSchema,
  RefundSucceeded,
  SalesSummarySchema,
} from '@udemy/contracts';
import { sql } from '@udemy/db';
import { signedWebhookRequest, stripeEvent } from '@udemy/payments/testing';
import {
  emulatorConfig,
  type RunningEmulator,
  silentLogger,
  startEmulator,
} from '@udemy/stripe-emulator';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { SECTION_8_PHASE_4_COMMERCE_C } from '../../testing/e2e/section-8';
import { deleteCatalogTestData } from '../catalog/testing/catalog-it';
import {
  createTestCategory,
  deleteEnrollmentTestData,
  type PublishedTestCourse,
  publishTestCourse,
} from '../enrollment/testing/enrollment-it';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { CommerceJobs } from './application/commerce-jobs';
import { CommerceSettings } from './application/commerce-settings';
import { RefundDispatcher } from './application/refund-dispatcher.service';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  deleteProviderEvents,
  insertTestCoupon,
  insertTestCourse,
  insertTestEnrollment,
  setTestPrice,
  type TestCourse,
  testCouponCode,
} from './testing/commerce-it';

/*
 * P4-T16 routes (design §8) through the REAL AppModule listening on a free port, with
 * `apps/stripe-emulator` in-process on another free port. Refunds go out through the real
 * `StripePaymentProvider` (`POST /v1/refunds` with `refund:{id}:{attempt}`), triggered by the
 * real post-commit kick (`COMMERCE_JOBS_ENABLED=true`, timers parked at 1 day), and come back
 * as SIGNED `charge.refunded` / `refund.updated` / `refund.failed` webhooks over HTTP.
 */
const V1 = '/api/v1';
const WEBHOOK = `${V1}/webhooks/stripe`;
const env = COMMERCE_C_E2E_ENV;
const DAY_MS = 86_400_000;

type Who = 'anonymous' | 'buyer' | 'stranger' | 'instructor' | 'admin' | 'buyerViaInstructorApp';
type Http = ReturnType<E2eHarness['as']>;

interface Fixtures {
  users: Record<'admin' | 'owner' | 'buyer' | 'stranger', SignedUpUser>;
  tokens: Record<'admin' | 'owner' | 'buyer' | 'stranger', AuthResult>;
  published: PublishedTestCourse;
}

interface Paid {
  orderId: string;
  lines: { id: string; courseId: string }[];
  line(courseId: string): string;
}

describe('commerce C endpoints (e2e: refunds, admin orders, sales; AppModule over HTTP, stripe-emulator)', () => {
  const e2e: E2eHarness = useE2eApp();
  const s3 = useIntegrationS3();
  const tag = randomUUID().slice(0, 8);
  const categoryIds: string[] = [];
  const courseIds: string[] = [];
  const extraUsers: SignedUpUser[] = [];
  const eventIds: string[] = [];
  let emulator: RunningEmulator | undefined;
  let fx: Fixtures | undefined;
  /** The buyer's paid order of the published course, refunded in the journey test. */
  let journey: { orderId: string; lineId: string; refundId: string } | undefined;

  const available = (): boolean =>
    e2e.pg.available && e2e.redis.available && s3.unavailableReason === undefined;
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    e2e.skip(ctx);
    s3.skipIfUnavailable(ctx);
  };
  const get = <T>(token: abstract new (...args: never[]) => T): T =>
    e2e.app.get(token, { strict: false });
  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const journeyOf = () => {
    if (journey === undefined) throw new Error('the journey test did not run');
    return journey;
  };
  const allUsers = (): SignedUpUser[] =>
    fx === undefined ? extraUsers : [...Object.values(fx.users), ...extraUsers];

  async function control(path: string, body: object = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${env.emulatorUrl}/_emulator${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`emulator ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  async function emulatorRefundsOf(refundId: string): Promise<{ id: string; status: string }[]> {
    const res = await fetch(`${env.emulatorUrl}/_emulator/state`);
    const state = (await res.json()) as {
      refunds: { id: string; status: string; metadata?: { refundId?: string } }[];
    };
    return state.refunds.filter((r) => r.metadata?.refundId === refundId);
  }

  async function emulatorEvents(
    type: string,
  ): Promise<{ id: string; objectId: string | null; status: string }[]> {
    const res = await fetch(`${env.emulatorUrl}/_emulator/events?type=${encodeURIComponent(type)}`);
    return (
      (await res.json()) as { data: { id: string; objectId: string | null; status: string }[] }
    ).data;
  }

  /** Every kick has finished, then every webhook the emulator queued has been delivered. */
  async function settle(): Promise<void> {
    await get(RefundDispatcher).whenIdle();
    expect((await control('/webhooks/drain?timeoutMs=20000')).idle).toBe(true);
    await get(RefundDispatcher).whenIdle();
  }

  async function student(label: string): Promise<{ user: SignedUpUser; http: Http }> {
    const user = await e2e.signup({ displayName: `Buyer ${label} ${tag}` });
    await e2e.verifyEmailViaSql(user.userId);
    extraUsers.push(user);
    const auth = await e2e.login('student', user.email);
    return { user, http: e2e.as('student', auth.accessToken) };
  }

  async function course(price: string): Promise<TestCourse> {
    const created = await insertTestCourse(e2e.pg.db, { ownerId: fixtures().users.owner.userId });
    courseIds.push(created.courseId);
    await setTestPrice(e2e.pg.db, created.courseId, price, fixtures().users.owner.userId);
    return created;
  }

  const sessionIdOf = (checkoutUrl: string | null): string => {
    const match = /\/pay\/(cs_test_[A-Za-z0-9]+)$/.exec(checkoutUrl ?? '');
    if (match?.[1] === undefined) throw new Error(`not an emulator checkout url: ${checkoutUrl}`);
    return match[1];
  };

  async function placeOrder(http: Http, courseIdsToBuy: readonly string[], code?: string) {
    for (const id of courseIdsToBuy) await http.put(`${V1}/me/cart/items/${id}`).expect(200);
    if (code !== undefined) await http.put(`${V1}/me/cart/coupon`).send({ code }).expect(200);
    const total = CartQuoteSchema.parse((await http.get(`${V1}/me/cart`).expect(200)).body).totals
      .totalAmount;
    return CheckoutResponseSchema.parse(
      (
        await http
          .post(`${V1}/me/checkout`)
          .set('Idempotency-Key', randomUUID())
          .send({ expectedTotal: total })
          .expect(201)
      ).body,
    );
  }

  /** Checkout -> emulator "Pay" -> signed webhook -> PAID. */
  async function buy(http: Http, courseIdsToBuy: readonly string[], code?: string): Promise<Paid> {
    const placed = await placeOrder(http, courseIdsToBuy, code);
    await control(`/checkout/sessions/${sessionIdOf(placed.checkoutUrl)}/complete`);
    await settle();
    const detail = OrderDetailSchema.parse(
      (await http.get(`${V1}/me/orders/${placed.orderId}`).expect(200)).body,
    );
    expect(detail.status).toBe('PAID');
    const lines = detail.lines.map((l) => ({ id: l.id, courseId: l.courseId }));
    return {
      orderId: placed.orderId,
      lines,
      line: (courseId) => {
        const found = lines.find((l) => l.courseId === courseId);
        if (found === undefined) throw new Error(`no line for ${courseId}`);
        return found.id;
      },
    };
  }

  function postRefund(http: Http, orderId: string, orderLineId: string): request.Test {
    return http
      .post(`${V1}/me/orders/${orderId}/refunds`)
      .send({ orderLineId, reasonCode: 'NOT_AS_EXPECTED', comment: 'Not for me.' });
  }

  async function refundRow(refundId: string) {
    return e2e.pg.db
      .selectFrom('commerce.refunds')
      .select(['status', 'attempt', 'providerRefundId', 'failureCode', 'initiatedBy'])
      .where('id', '=', refundId)
      .executeTakeFirstOrThrow();
  }

  async function orderStatus(orderId: string): Promise<string> {
    return (
      await e2e.pg.db
        .selectFrom('commerce.orders')
        .select('status')
        .where('id', '=', orderId)
        .executeTakeFirstOrThrow()
    ).status;
  }

  async function outboxOf(orderId: string, type: string): Promise<unknown[]> {
    const rows = await e2e.pg.db
      .selectFrom('outbox.events')
      .select('payload')
      .where('aggregateId', '=', orderId)
      .where('type', '=', type)
      .orderBy('createdAt')
      .execute();
    return rows.map((r) => r.payload);
  }

  function call(who: Who, method: HttpMethod, path: string): request.Test {
    const { tokens } = fixtures();
    switch (who) {
      case 'anonymous':
        return e2e.http()[method](path).set(e2e.client('student'));
      case 'buyer':
        return e2e.as('student', tokens.buyer.accessToken).call(method, path);
      case 'stranger':
        return e2e.as('student', tokens.stranger.accessToken).call(method, path);
      case 'instructor':
        return e2e.as('instructor', tokens.owner.accessToken).call(method, path);
      case 'admin':
        return e2e.as('admin', tokens.admin.accessToken).call(method, path);
      case 'buyerViaInstructorApp':
        return e2e.as('instructor', tokens.buyer.accessToken).call(method, path);
    }
  }

  const adminHttp = (): Http => e2e.as('admin', fixtures().tokens.admin.accessToken);

  /** Runs `work` with the post-commit kick switched off (the refunds stay APPROVED). */
  async function withoutKick<T>(work: () => Promise<T>): Promise<T> {
    const settings = get(CommerceSettings);
    Object.defineProperty(settings, 'jobsEnabled', { value: false, configurable: true });
    try {
      return await work();
    } finally {
      Object.defineProperty(settings, 'jobsEnabled', { value: true, configurable: true });
    }
  }

  beforeAll(async () => {
    if (!available()) return;
    emulator = await startEmulator(
      emulatorConfig({
        secretKey: env.secretKey,
        webhookSecret: env.webhookSecret,
        webhookUrl: env.webhookUrl,
        publicUrl: env.emulatorUrl,
        webhookMaxAttempts: 3,
        webhookRetryBaseMs: 50,
        webhookRetryMaxMs: 200,
      }),
      { port: env.emulatorPort, host: '127.0.0.1' },
      { logger: silentLogger },
    );
    await e2e.app.listen(env.apiPort, '127.0.0.1');

    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    const buyer = await e2e.signup({ displayName: `Buyer ${tag}` });
    const stranger = await e2e.signup({ displayName: `Stranger ${tag}` });
    for (const u of [owner, buyer, stranger]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(owner.userId, admin.userId);
    categoryIds.push(...(await createTestCategory(get, tag)));
    const published = await publishTestCourse(get, e2e.pg.db, s3.storage, {
      ownerId: owner.userId,
      adminId: admin.userId,
      categoryId: categoryIds[0] ?? '',
      title: `Commerce C e2e ${tag}`,
    });
    await setTestPrice(e2e.pg.db, published.courseId, '19.99', owner.userId);
    fx = {
      users: { admin, owner, buyer, stranger },
      tokens: {
        admin: await e2e.login('admin', admin.email),
        owner: await e2e.login('instructor', owner.email),
        buyer: await e2e.login('student', buyer.email),
        stranger: await e2e.login('student', stranger.email),
      },
      published,
    };
  });

  beforeEach(async () => {
    if (!available() || fx === undefined) return;
    const keys = commerceRateLimitTestKeys({ userIds: allUsers().map((u) => u.userId) });
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
  });

  afterAll(async () => {
    if (available()) await get(RefundDispatcher).whenIdle();
    await emulator?.close();
    if (!available() || fx === undefined) return;
    const ids = allUsers().map((u) => u.userId);
    const keys = commerceRateLimitTestKeys({ userIds: ids, courseIds });
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
    // The harness deletes the users afterwards (its afterAll runs after this one).
    await deleteCommerceTestData(e2e.pg.db, { userIds: ids, courseIds, deleteUsers: false });
    await deleteProviderEvents(e2e.pg.db, eventIds);
    await deleteEnrollmentTestData(e2e.pg.db, { userIds: ids, courseIds: [fx.published.courseId] });
    await deleteMediaTestData(e2e.pg.db, ids, { storage: s3.storage });
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: ids, categoryIds, deleteUsers: false });
  });

  /* ------------------------------------------------------------------ the journey */

  it('paid -> lecture plays -> refund request (auto-approved) -> lecture locked at once -> kick dispatches to the emulator -> signed webhooks -> SUCCEEDED, order REFUNDED', async (ctx) => {
    skip(ctx);
    const { tokens, published } = fixtures();
    const buyer = e2e.as('student', tokens.buyer.accessToken);
    const master = `${V1}/catalog/courses/${published.courseId}/lectures/${published.lockedVideoId}/hls/master.m3u8`;
    const order = await buy(buyer, [published.courseId]);
    expect((await buyer.get(master).expect(200)).text).toContain('#EXTM3U');

    const lineId = order.line(published.courseId);
    const refund = RefundSchema.parse(
      (await postRefund(buyer, order.orderId, lineId).expect(201)).body,
    );
    expect(refund).toMatchObject({ status: 'APPROVED', initiatedBy: 'STUDENT', amount: '19.99' });
    journey = { orderId: order.orderId, lineId, refundId: refund.id };
    // Revoked at approval (D11), before the provider is even called.
    expectProblem(await buyer.get(master), 403, ErrorCode.LectureLocked);

    await settle();
    expect(await emulatorRefundsOf(refund.id)).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUCCEEDED', attempt: 1 });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
    const succeeded = await outboxOf(order.orderId, 'RefundSucceeded.v1');
    expect(succeeded).toHaveLength(1);
    expect(RefundSucceeded.parsePayload(succeeded[0])).toMatchObject({
      refundId: refund.id,
      instructorShareAmount: '13.99',
      platformShareAmount: '6.00',
    });
    const detail = OrderDetailSchema.parse(
      (await buyer.get(`${V1}/me/orders/${order.orderId}`).expect(200)).body,
    );
    expect(detail).toMatchObject({ status: 'REFUNDED', refundedAmount: '19.99' });
    expectProblem(await buyer.get(master), 403, ErrorCode.LectureLocked);

    // The emulator's refund.updated, redelivered with the same id and bytes: processed once.
    const charge = (await emulatorEvents('refund.updated')).find((e) => e.status === 'delivered');
    const again = await control(`/events/${charge?.id ?? ''}/redeliver`);
    expect(again.attempt).toMatchObject({ statusCode: 200 });
    const claims = await e2e.pg.db
      .selectFrom('commerce.providerEvents')
      .select('eventId')
      .where('eventId', '=', charge?.id ?? '')
      .execute();
    expect(claims).toHaveLength(1);
    expect(await outboxOf(order.orderId, 'RefundSucceeded.v1')).toHaveLength(1);
  });

  it('pending at the provider: SUBMITTED, then the settle webhook (refund.updated) makes it SUCCEEDED', async (ctx) => {
    skip(ctx);
    const { http } = await student('pending');
    const c = await course('24.99');
    const order = await buy(http, [c.courseId]);
    await control('/refunds/next', { outcome: 'pending' });
    const refund = RefundSchema.parse(
      (await postRefund(http, order.orderId, order.line(c.courseId)).expect(201)).body,
    );
    await settle();
    const submitted = await refundRow(refund.id);
    expect(submitted).toMatchObject({ status: 'SUBMITTED' });
    await control(`/refunds/${submitted.providerRefundId ?? ''}/settle`, { outcome: 'succeeded' });
    await settle();
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUCCEEDED' });
    const log = await e2e.pg.db
      .selectFrom('commerce.refundTransitions')
      .select(['toStatus', 'providerEventId'])
      .where('refundId', '=', refund.id)
      .orderBy('seq')
      .execute();
    expect(log.map((t) => t.toStatus)).toEqual(['APPROVED', 'SUBMITTED', 'SUCCEEDED']);
    expect(log[2]?.providerEventId).toMatch(/^evt_/); // settled by a webhook
    if (log[2]?.providerEventId) eventIds.push(log[2].providerEventId);
  });

  it('provider failure -> FAILED (admin queue, RefundFailed) -> admin retry (attempt 2) -> SUCCEEDED', async (ctx) => {
    skip(ctx);
    const { http } = await student('failure');
    const c = await course('19.99');
    const order = await buy(http, [c.courseId]);
    await control('/refunds/fail-next', { failureReason: 'expired_or_canceled_card' });
    const refund = RefundSchema.parse(
      (await postRefund(http, order.orderId, order.line(c.courseId)).expect(201)).body,
    );
    await settle();
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'expired_or_canceled_card',
    });
    expect(await outboxOf(order.orderId, 'RefundFailed.v1')).toEqual([
      expect.objectContaining({
        refundId: refund.id,
        attempt: 1,
        failureCode: 'expired_or_canceled_card',
      }),
    ]);
    const queue = AdminRefundQueuePageSchema.parse(
      (await adminHttp().get(`${V1}/admin/refunds?status=FAILED&limit=100`).expect(200)).body,
    );
    expect(queue.items.find((i) => i.id === refund.id)).toMatchObject({
      status: 'FAILED',
      attempt: 1,
    });

    const retried = RefundDecisionResponseSchema.parse(
      (await adminHttp().post(`${V1}/admin/refunds/${refund.id}/retry`).send({}).expect(200)).body,
    );
    expect(retried).toMatchObject({ status: 'APPROVED', attempt: 2, failureCode: null });
    await settle();
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
    expect((await emulatorRefundsOf(refund.id)).map((r) => r.status).sort()).toEqual([
      'failed',
      'succeeded',
    ]);
    expectProblem(
      await adminHttp().post(`${V1}/admin/refunds/${refund.id}/retry`).send({}),
      409,
      ErrorCode.InvalidStateTransition,
    );
  });

  it('two dispatchers at once: one POST /v1/refunds', async (ctx) => {
    skip(ctx);
    const { http } = await student('race');
    const c = await course('19.99');
    const order = await buy(http, [c.courseId]);
    const refund = await withoutKick(async () =>
      RefundSchema.parse(
        (await postRefund(http, order.orderId, order.line(c.courseId)).expect(201)).body,
      ),
    );
    expect(await refundRow(refund.id)).toMatchObject({ status: 'APPROVED' });
    const jobs = get(CommerceJobs);
    const reports = await Promise.all([
      jobs.dispatchRefunds({ refundIds: [refund.id] }),
      jobs.dispatchRefunds({ refundIds: [refund.id] }),
    ]);
    expect(reports.reduce((n, r) => n + r.leased, 0)).toBe(1);
    expect(await emulatorRefundsOf(refund.id)).toHaveLength(1);
    await settle();
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('charge.refunded (no refund ids, §14) settles the SUBMITTED refund of that payment', async (ctx) => {
    skip(ctx);
    const { http } = await student('charge');
    const c = await course('29.99');
    const order = await buy(http, [c.courseId]);
    await control('/refunds/next', { outcome: 'pending' });
    const refund = RefundSchema.parse(
      (await postRefund(http, order.orderId, order.line(c.courseId)).expect(201)).body,
    );
    await settle();
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUBMITTED' });
    const payment = await e2e.pg.db
      .selectFrom('commerce.payments')
      .select('paymentIntentId')
      .where('orderId', '=', order.orderId)
      .executeTakeFirstOrThrow();
    const event = stripeEvent('charge.refunded', {
      id: `ch_${randomUUID().replace(/-/g, '')}`,
      object: 'charge',
      amount: 2999,
      amount_refunded: 2999,
      refunded: true,
      currency: 'usd',
      payment_intent: payment.paymentIntentId,
      livemode: false,
    });
    eventIds.push(event.id);
    const signed = signedWebhookRequest(event, env.webhookSecret);
    await e2e
      .http()
      .post(WEBHOOK)
      .set(signed.headers)
      .send(signed.body.toString('utf8'))
      .expect(200);
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
    const outcome = await e2e.pg.db
      .selectFrom('commerce.providerEvents')
      .select(['outcome', 'orderId'])
      .where('eventId', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(outcome).toEqual({ outcome: 'APPLIED', orderId: order.orderId });
  });

  it('>= 3 refunds in 90 days -> REQUESTED (under review) -> admin approve / reject over HTTP; after 30 days -> refund_window_closed', async (ctx) => {
    skip(ctx);
    const { http, user } = await student('abuse');
    const courses: TestCourse[] = [];
    for (let i = 0; i < 5; i += 1) courses.push(await course('19.99'));
    const order = await buy(
      http,
      courses.map((c) => c.courseId),
    );
    const statuses: string[] = [];
    const ids: string[] = [];
    for (const c of courses) {
      const r = RefundSchema.parse(
        (await postRefund(http, order.orderId, order.line(c.courseId)).expect(201)).body,
      );
      statuses.push(r.status);
      ids.push(r.id);
    }
    expect(statuses).toEqual(['APPROVED', 'APPROVED', 'APPROVED', 'REQUESTED', 'REQUESTED']);
    await settle();

    const queue = AdminRefundQueuePageSchema.parse(
      (await adminHttp().get(`${V1}/admin/refunds?limit=100`).expect(200)).body,
    );
    expect(
      queue.items.filter((i) => i.userId === user.userId).map((i) => [i.id, i.recentRefundCount]),
    ).toEqual([
      [ids[3], 3],
      [ids[4], 4],
    ]);
    const approved = RefundDecisionResponseSchema.parse(
      (await adminHttp().post(`${V1}/admin/refunds/${ids[3]}/approve`).send({}).expect(200)).body,
    );
    expect(approved.status).toBe('APPROVED');
    expectProblem(
      await adminHttp().post(`${V1}/admin/refunds/${ids[4]}/reject`).send({ reason: 'short' }),
      400,
      ErrorCode.ValidationFailed,
    );
    const rejected = RefundDecisionResponseSchema.parse(
      (
        await adminHttp()
          .post(`${V1}/admin/refunds/${ids[4]}/reject`)
          .send({ reason: 'The course was completed already.' })
          .expect(200)
      ).body,
    );
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'The course was completed already.',
    });
    await settle();
    expect(await refundRow(ids[3] ?? '')).toMatchObject({ status: 'SUCCEEDED' });
    const enrolled = await e2e.pg.db
      .selectFrom('enrollment.enrollments')
      .select(['courseId', 'status'])
      .where('userId', '=', user.userId)
      .execute();
    expect(enrolled.filter((e) => e.status === 'ACTIVE').map((e) => e.courseId)).toEqual([
      courses[4]?.courseId,
    ]);

    // After the window: refused (a new order, aged 31 days). Five requests used the 24 h budget.
    await e2e.redis.redis.del(...commerceRateLimitTestKeys({ userIds: [user.userId] }));
    const late = await course('19.99');
    const lateOrder = await buy(http, [late.courseId]);
    await e2e.pg.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      const back = sql`interval '31 days'`;
      await sql`UPDATE commerce.orders SET placed_at = placed_at - ${back}, paid_at = paid_at - ${back} WHERE id = ${lateOrder.orderId}`.execute(
        trx,
      );
      await sql`UPDATE commerce.order_transitions SET occurred_at = occurred_at - ${back} WHERE order_id = ${lateOrder.orderId}`.execute(
        trx,
      );
      await sql`UPDATE commerce.payments SET created_at = created_at - ${back}, session_expires_at = session_expires_at - ${back}, succeeded_at = succeeded_at - ${back} WHERE order_id = ${lateOrder.orderId}`.execute(
        trx,
      );
    });
    expectProblem(
      await postRefund(http, lateOrder.orderId, lateOrder.line(late.courseId)),
      422,
      ErrorCode.RefundWindowClosed,
    );
  });

  it('D15: a second payment for an active course creates a SYSTEM refund that the kick sends; the access is kept', async (ctx) => {
    skip(ctx);
    const { http, user } = await student('duplicate');
    const c = await course('19.99');
    const placed = await placeOrder(http, [c.courseId]);
    await insertTestEnrollment(e2e.pg.db, user.userId, c.courseId);
    await control(`/checkout/sessions/${sessionIdOf(placed.checkoutUrl)}/complete`);
    await settle();
    const refunds = await e2e.pg.db
      .selectFrom('commerce.refunds')
      .select(['id', 'status', 'initiatedBy', 'reasonCode'])
      .where('orderId', '=', placed.orderId)
      .execute();
    expect(refunds).toEqual([
      expect.objectContaining({
        status: 'SUCCEEDED',
        initiatedBy: 'SYSTEM',
        reasonCode: 'DUPLICATE_PURCHASE',
      }),
    ]);
    expect(await emulatorRefundsOf(refunds[0]?.id ?? '')).toHaveLength(1);
    expect(await orderStatus(placed.orderId)).toBe('REFUNDED');
    const enrollment = await e2e.pg.db
      .selectFrom('enrollment.enrollments')
      .select('status')
      .where('userId', '=', user.userId)
      .where('courseId', '=', c.courseId)
      .executeTakeFirstOrThrow();
    expect(enrollment.status).toBe('ACTIVE');
  });

  it('PAYMENT_REVIEW accept over HTTP: PAID with the enrollment; a second accept is 409', async (ctx) => {
    skip(ctx);
    const { http, user } = await student('review');
    const c = await course('19.99');
    const placed = await placeOrder(http, [c.courseId]);
    const event = stripeEvent('checkout.session.completed', {
      id: sessionIdOf(placed.checkoutUrl),
      object: 'checkout.session',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 2099,
      currency: 'usd',
      client_reference_id: placed.orderId,
      metadata: { orderId: placed.orderId },
      payment_intent: `pi_${randomUUID().replace(/-/g, '')}`,
    });
    const signed = signedWebhookRequest(event, env.webhookSecret);
    await e2e
      .http()
      .post(WEBHOOK)
      .set(signed.headers)
      .send(signed.body.toString('utf8'))
      .expect(200);
    expect(await orderStatus(placed.orderId)).toBe('PAYMENT_REVIEW');
    const accepted = AdminOrderDetailSchema.parse(
      (
        await adminHttp()
          .post(`${V1}/admin/orders/${placed.orderId}/accept-payment`)
          .send({ reason: 'Overpaid by 1.00, accepted by support.' })
          .expect(200)
      ).body,
    );
    expect(accepted.status).toBe('PAID');
    expect(accepted.timeline.filter((e) => e.kind === 'ORDER').map((e) => e.toStatus)).toEqual([
      'PENDING_PAYMENT',
      'PAYMENT_REVIEW',
      'PAID',
    ]);
    expect(accepted.transitions.at(-1)).toMatchObject({
      cause: 'ADMIN',
      actorId: fixtures().users.admin.userId,
      actor: { id: fixtures().users.admin.userId },
    });
    const enrolled = await e2e.pg.db
      .selectFrom('enrollment.enrollments')
      .select('status')
      .where('userId', '=', user.userId)
      .where('courseId', '=', c.courseId)
      .executeTakeFirstOrThrow();
    expect(enrolled.status).toBe('ACTIVE');
    expectProblem(
      await adminHttp()
        .post(`${V1}/admin/orders/${placed.orderId}/accept-payment`)
        .send({ reason: 'Overpaid by 1.00, accepted by support.' }),
      409,
      ErrorCode.InvalidStateTransition,
    );
  });

  it('admin search by buyer email and order number; detail with the merged timeline and actor names; admin refund of a line', async (ctx) => {
    skip(ctx);
    const { http, user } = await student('admin-view');
    const a = await course('19.99');
    const b = await course('24.99');
    const order = await buy(http, [a.courseId, b.courseId]);
    const local = user.email.slice(0, user.email.indexOf('@'));
    const page = AdminOrderPageSchema.parse(
      (
        await adminHttp()
          .get(`${V1}/admin/orders?buyerEmail=${encodeURIComponent(local.toUpperCase())}`)
          .expect(200)
      ).body,
    );
    expect(page.items.map((i) => i.id)).toEqual([order.orderId]);
    expect(page.items[0]?.buyer).toMatchObject({ id: user.userId, email: user.email });
    expectProblem(
      await adminHttp().get(`${V1}/admin/orders?buyerEmail=ab`),
      400,
      ErrorCode.ValidationFailed,
    );
    const number = page.items[0]?.orderNumber ?? 0;
    expect(
      AdminOrderPageSchema.parse(
        (await adminHttp().get(`${V1}/admin/orders?q=${number}`).expect(200)).body,
      ).items.map((i) => i.id),
    ).toEqual([order.orderId]);

    const created = AdminRefundOrderLinesResponseSchema.parse(
      (
        await adminHttp()
          .post(`${V1}/admin/orders/${order.orderId}/refunds`)
          .send({ orderLineIds: [order.line(b.courseId)], reason: 'Support goodwill refund.' })
          .expect(201)
      ).body,
    );
    expect(created).toEqual([
      expect.objectContaining({
        initiatedBy: 'ADMIN',
        reasonCode: 'ADMIN_DISCRETION',
        status: 'APPROVED',
      }),
    ]);
    await settle();
    const detail = AdminOrderDetailSchema.parse(
      (await adminHttp().get(`${V1}/admin/orders/${order.orderId}`).expect(200)).body,
    );
    expect(detail.status).toBe('PARTIALLY_REFUNDED');
    const adminName = (
      await e2e.pg.db
        .selectFrom('identity.users')
        .select('displayName')
        .where('id', '=', fixtures().users.admin.userId)
        .executeTakeFirstOrThrow()
    ).displayName;
    expect(detail.refunds[0]?.transitions[0]).toMatchObject({
      toStatus: 'APPROVED',
      actor: { displayName: adminName },
      reason: 'Support goodwill refund.',
    });
    expect(detail.transitions[0]?.actor).toEqual({
      id: user.userId,
      displayName: `Buyer admin-view ${tag}`,
    });
    const kinds = detail.timeline.map((e) => e.kind);
    expect(new Set(kinds)).toEqual(new Set(['ORDER', 'PAYMENT', 'REFUND']));
    expect(detail.timeline.map((e) => Date.parse(e.at))).toEqual(
      [...detail.timeline.map((e) => Date.parse(e.at))].sort((x, y) => x - y),
    );
    expect(detail.timeline.filter((e) => e.kind === 'REFUND').at(-1)).toMatchObject({
      toStatus: 'SUCCEEDED',
    });
    expect(detail.providerEvents.map((e) => e.type)).toEqual(
      expect.arrayContaining(['checkout.session.completed', 'refund.updated']),
    );
    expectProblem(
      await adminHttp()
        .post(`${V1}/admin/orders/${order.orderId}/refunds`)
        .send({ orderLineIds: [order.line(b.courseId)], reason: 'Support goodwill refund.' }),
      409,
      ErrorCode.RefundAlreadyRequested,
    );
  });

  it('instructor sales over HTTP: the numbers match the SQL 70% share, refunds subtract', async (ctx) => {
    skip(ctx);
    const teacher = await e2e.signup({ displayName: `Teacher ${tag}` });
    await e2e.verifyEmailViaSql(teacher.userId);
    extraUsers.push(teacher);
    await e2e.promoteToInstructor(teacher.userId, fixtures().users.admin.userId);
    const teacherHttp = e2e.as(
      'instructor',
      (await e2e.login('instructor', teacher.email)).accessToken,
    );
    const mk = async (price: string) => {
      const created = await insertTestCourse(e2e.pg.db, { ownerId: teacher.userId });
      courseIds.push(created.courseId);
      await setTestPrice(e2e.pg.db, created.courseId, price, teacher.userId);
      return created;
    };
    const a = await mk('19.99');
    const b = await mk('24.99');
    const code = testCouponCode('HALF');
    await insertTestCoupon(e2e.pg.db, {
      createdBy: teacher.userId,
      courseId: b.courseId,
      code,
      percentOff: 50,
    });
    const one = await student('sales-1');
    const two = await student('sales-2');
    await buy(one.http, [a.courseId, b.courseId], code);
    const refunded = await buy(two.http, [a.courseId]);
    await postRefund(two.http, refunded.orderId, refunded.line(a.courseId)).expect(201);
    await settle();

    const from = new Date(Date.now() - DAY_MS).toISOString();
    const to = new Date(Date.now() + DAY_MS).toISOString();
    const summary = SalesSummarySchema.parse(
      (
        await teacherHttp
          .get(
            `${V1}/instructor/sales/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          )
          .expect(200)
      ).body,
    );
    expect(summary.totals).toEqual({
      salesCount: 3,
      refundCount: 1,
      gross: '64.97',
      discounts: '12.50',
      refunded: '19.99',
      net: '32.48',
      instructorShare: '22.73',
    });
    expect(summary.courses.map((c) => [c.courseId, c.net, c.instructorShare])).toEqual([
      [a.courseId, '19.99', '13.99'],
      [b.courseId, '12.49', '8.74'],
    ]);
    const recent = RecentSalePageSchema.parse(
      (await teacherHttp.get(`${V1}/instructor/sales?limit=10`).expect(200)).body,
    );
    expect(recent.items).toHaveLength(3);
    expect(recent.items.filter((s) => s.refunded)).toHaveLength(1);
    // No buyer PII anywhere in the response.
    expect(JSON.stringify(recent)).not.toContain(one.user.email);
    // The other instructor (the suite's owner) does not see these sales.
    const ownerSales = RecentSalePageSchema.parse(
      (await call('instructor', 'get', `${V1}/instructor/sales?courseId=${a.courseId}`).expect(200))
        .body,
    );
    expect(ownerSales.items).toEqual([]);
    expectProblem(
      await teacherHttp.get(
        `${V1}/instructor/sales/summary?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`,
      ),
      400,
      ErrorCode.ValidationFailed,
    );
  });

  /* ------------------------------------------------------------------ authorization matrix */

  const refundOf = () => journeyOf().refundId;
  const orderOf = () => journeyOf().orderId;
  const from = encodeURIComponent('2026-01-01T00:00:00.000Z');
  const to = encodeURIComponent('2026-12-31T00:00:00.000Z');

  const ROUTES: readonly {
    readonly template: string;
    readonly method: HttpMethod;
    readonly path: () => string;
    readonly body?: () => object;
  }[] = [
    {
      template: `${V1}/me/orders/{orderId}/refunds`,
      method: 'post',
      path: () => `${V1}/me/orders/${orderOf()}/refunds`,
      body: () => ({ orderLineId: journeyOf().lineId, reasonCode: 'QUALITY' }),
    },
    {
      template: `${V1}/instructor/sales/summary`,
      method: 'get',
      path: () => `${V1}/instructor/sales/summary?from=${from}&to=${to}`,
    },
    { template: `${V1}/instructor/sales`, method: 'get', path: () => `${V1}/instructor/sales` },
    { template: `${V1}/admin/orders`, method: 'get', path: () => `${V1}/admin/orders` },
    {
      template: `${V1}/admin/orders/{orderId}`,
      method: 'get',
      path: () => `${V1}/admin/orders/${orderOf()}`,
    },
    {
      template: `${V1}/admin/orders/{orderId}/refunds`,
      method: 'post',
      path: () => `${V1}/admin/orders/${orderOf()}/refunds`,
      body: () => ({ orderLineIds: [journeyOf().lineId], reason: 'Matrix refund attempt.' }),
    },
    {
      template: `${V1}/admin/orders/{orderId}/accept-payment`,
      method: 'post',
      path: () => `${V1}/admin/orders/${orderOf()}/accept-payment`,
      body: () => ({ reason: 'Matrix accept attempt.' }),
    },
    { template: `${V1}/admin/refunds`, method: 'get', path: () => `${V1}/admin/refunds` },
    {
      template: `${V1}/admin/refunds/{refundId}/approve`,
      method: 'post',
      path: () => `${V1}/admin/refunds/${refundOf()}/approve`,
      body: () => ({}),
    },
    {
      template: `${V1}/admin/refunds/{refundId}/reject`,
      method: 'post',
      path: () => `${V1}/admin/refunds/${refundOf()}/reject`,
      body: () => ({ reason: 'Matrix reject attempt.' }),
    },
    {
      template: `${V1}/admin/refunds/{refundId}/retry`,
      method: 'post',
      path: () => `${V1}/admin/refunds/${refundOf()}/retry`,
      body: () => ({}),
    },
  ];

  const ADMIN_ONLY = (adminStatus: number): Record<Who, number> => ({
    anonymous: 401,
    buyerViaInstructorApp: 401,
    buyer: 403,
    stranger: 403,
    instructor: 403,
    admin: adminStatus,
  });
  const INSTRUCTOR_ONLY: Record<Who, number> = {
    anonymous: 401,
    buyerViaInstructorApp: 401,
    buyer: 403,
    stranger: 403,
    instructor: 200,
    admin: 403,
  };

  /** Status per route and caller (the buyer owns the journey's REFUNDED order). */
  const MATRIX: Readonly<Record<string, Readonly<Record<Who, number>>>> = {
    [`POST ${V1}/me/orders/{orderId}/refunds`]: {
      anonymous: 401,
      buyerViaInstructorApp: 401,
      instructor: 403,
      admin: 404,
      stranger: 404,
      buyer: 409,
    },
    [`GET ${V1}/instructor/sales/summary`]: INSTRUCTOR_ONLY,
    [`GET ${V1}/instructor/sales`]: INSTRUCTOR_ONLY,
    [`GET ${V1}/admin/orders`]: ADMIN_ONLY(200),
    [`GET ${V1}/admin/orders/{orderId}`]: ADMIN_ONLY(200),
    // The order is REFUNDED: nothing left to refund (refund_not_applicable).
    [`POST ${V1}/admin/orders/{orderId}/refunds`]: ADMIN_ONLY(422),
    // The order is REFUNDED, not PAYMENT_REVIEW.
    [`POST ${V1}/admin/orders/{orderId}/accept-payment`]: ADMIN_ONLY(409),
    [`GET ${V1}/admin/refunds`]: ADMIN_ONLY(200),
    // The refund is SUCCEEDED.
    [`POST ${V1}/admin/refunds/{refundId}/approve`]: ADMIN_ONLY(409),
    [`POST ${V1}/admin/refunds/{refundId}/reject`]: ADMIN_ONLY(409),
    [`POST ${V1}/admin/refunds/{refundId}/retry`]: ADMIN_ONLY(409),
  };

  it('the matrix covers exactly SECTION_8_PHASE_4_COMMERCE_C', () => {
    const covered = ROUTES.map((r) => `${r.method.toUpperCase()} ${r.template}`).sort();
    expect(covered).toEqual(
      SECTION_8_PHASE_4_COMMERCE_C.map(([p, m]) => `${m.toUpperCase()} ${p}`).sort(),
    );
    expect(Object.keys(MATRIX).sort()).toEqual(covered);
  });

  it('auth matrix: every route x anonymous / buyer / another student / instructor app / admin / buyer token via the instructor app', async (ctx) => {
    skip(ctx);
    const codes: Record<number, string | undefined> = {
      401: 'unauthorized',
      403: ErrorCode.Forbidden,
      404: undefined,
    };
    for (const route of ROUTES) {
      const expected = MATRIX[`${route.method.toUpperCase()} ${route.template}`] ?? {};
      for (const [who, status] of Object.entries(expected) as [Who, number][]) {
        const req = call(who, route.method, route.path());
        const res = await (route.body === undefined ? req : req.send(route.body()));
        expect(
          res.status,
          `${route.method} ${route.template} as ${who}: ${JSON.stringify(res.body)}`,
        ).toBe(status);
        if (status >= 400) expectProblem(res, status, codes[status]);
      }
    }
    // Malformed ids are 404 (policy) or 400 (admin param validation).
    expectProblem(
      await call('buyer', 'post', `${V1}/me/orders/not-a-uuid/refunds`).send({
        orderLineId: randomUUID(),
        reasonCode: 'QUALITY',
      }),
      404,
    );
    expectProblem(
      await call('admin', 'get', `${V1}/admin/orders/not-a-uuid`),
      400,
      ErrorCode.ValidationFailed,
    );
    expectProblem(
      await call('admin', 'post', `${V1}/admin/refunds/${randomUUID()}/approve`).send({}),
      404,
      ErrorCode.RefundNotFound,
    );
    expectProblem(
      await call('buyer', 'post', `${V1}/me/orders/${orderOf()}/refunds`).send({
        orderLineId: journeyOf().lineId,
        reasonCode: 'DUPLICATE_PURCHASE',
      }),
      400,
      ErrorCode.ValidationFailed,
    );
  });
});
