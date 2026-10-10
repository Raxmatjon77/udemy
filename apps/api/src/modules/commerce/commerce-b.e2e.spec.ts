// Must stay the first import: AppModule validates process.env when it is imported.
import { COMMERCE_E2E_ENV } from './testing/apply-commerce-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  type AuthResult,
  CartChangedProblemSchema,
  CartQuoteSchema,
  CheckoutInProgressProblemSchema,
  CheckoutResponseSchema,
  ErrorCode,
  OrderDetailSchema,
  OrderSummaryPageSchema,
  PriceChangedProblemSchema,
  ReceiptSchema,
  WebhookAckSchema,
} from '@udemy/contracts';
import { signedWebhookRequest, signTestWebhook, stripeEvent } from '@udemy/payments/testing';
import {
  emulatorConfig,
  type RunningEmulator,
  silentLogger,
  startEmulator,
} from '@udemy/stripe-emulator';
import { sql } from '@udemy/db';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { SECTION_8_PHASE_4_COMMERCE_B } from '../../testing/e2e/section-8';
import { deleteCatalogTestData } from '../catalog/testing/catalog-it';
import {
  createTestCategory,
  deleteEnrollmentTestData,
  type PublishedTestCourse,
  publishTestCourse,
} from '../enrollment/testing/enrollment-it';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { CommerceJobs } from './application/commerce-jobs';
import { ReconcileRepository } from './application/ports/reconcile.repository';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  deleteProviderEvents,
  insertTestCoupon,
  insertTestCourse,
  setTestPrice,
  type TestCourse,
  testCouponCode,
} from './testing/commerce-it';

/*
 * P4-T15 routes (design §8) through the REAL AppModule listening on a free port, with
 * `apps/stripe-emulator` in-process on another free port: the real `StripePaymentProvider`
 * calls the emulator, the emulator's hosted-page "Pay" (control API) sends a SIGNED
 * `checkout.session.completed` to `POST /api/v1/webhooks/stripe` over HTTP, and the raw-body
 * signature guard, dedupe and the PAID transaction run for real. Throwaway `sk_test_` key and
 * `whsec_` secret per run (D12); no Stripe account.
 *
 * Courses: one published through the real catalog (MinIO media) to prove the lecture unlocks
 * after payment; the others written straight into the catalog tables (commerce-it).
 */
const V1 = '/api/v1';
const WEBHOOK = `${V1}/webhooks/stripe`;
const env = COMMERCE_E2E_ENV;

type Who = 'anonymous' | 'buyer' | 'stranger' | 'instructor' | 'admin' | 'buyerViaInstructorApp';

interface Fixtures {
  users: Record<'admin' | 'owner' | 'buyer' | 'stranger' | 'unverified', SignedUpUser>;
  tokens: Record<'admin' | 'owner' | 'buyer' | 'stranger' | 'unverified', AuthResult>;
  published: PublishedTestCourse;
}

describe('commerce B endpoints (e2e: AppModule over HTTP, stripe-emulator, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp();
  const s3 = useIntegrationS3();
  const tag = randomUUID().slice(0, 8);
  const categoryIds: string[] = [];
  const courseIds: string[] = [];
  const extraUsers: SignedUpUser[] = [];
  const eventIds: string[] = [];
  let emulator: RunningEmulator | undefined;
  let fx: Fixtures | undefined;

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

  async function emulatorEvents(
    type: string,
  ): Promise<{ id: string; objectId: string | null; status: string }[]> {
    const res = await fetch(`${env.emulatorUrl}/_emulator/events?type=${encodeURIComponent(type)}`);
    return (
      (await res.json()) as { data: { id: string; objectId: string | null; status: string }[] }
    ).data;
  }

  const drain = async (): Promise<void> => {
    expect((await control('/webhooks/drain?timeoutMs=20000')).idle).toBe(true);
  };

  /** A fresh, verified student with a session in the student app (for one scenario). */
  async function student(
    label: string,
  ): Promise<{ user: SignedUpUser; http: ReturnType<E2eHarness['as']> }> {
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

  async function cartTotal(http: ReturnType<E2eHarness['as']>): Promise<string> {
    return CartQuoteSchema.parse((await http.get(`${V1}/me/cart`).expect(200)).body).totals
      .totalAmount;
  }

  function postCheckout(
    http: ReturnType<E2eHarness['as']>,
    expectedTotal: string,
    key: string | null = randomUUID(),
  ): request.Test {
    const req = http.post(`${V1}/me/checkout`);
    return (key === null ? req : req.set('Idempotency-Key', key)).send({ expectedTotal });
  }

  const sessionIdOf = (checkoutUrl: string | null): string => {
    const match = /\/pay\/(cs_test_[A-Za-z0-9]+)$/.exec(checkoutUrl ?? '');
    if (match?.[1] === undefined) throw new Error(`not an emulator checkout url: ${checkoutUrl}`);
    return match[1];
  };

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
    const unverified = await e2e.signup({ displayName: `Unverified ${tag}` });
    for (const u of [owner, buyer, stranger]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(owner.userId, admin.userId);
    categoryIds.push(...(await createTestCategory(get, tag)));
    const published = await publishTestCourse(get, e2e.pg.db, s3.storage, {
      ownerId: owner.userId,
      adminId: admin.userId,
      categoryId: categoryIds[0] ?? '',
      title: `Commerce e2e ${tag}`,
    });
    await setTestPrice(e2e.pg.db, published.courseId, '19.99', owner.userId);
    fx = {
      users: { admin, owner, buyer, stranger, unverified },
      tokens: {
        admin: await e2e.login('admin', admin.email),
        owner: await e2e.login('instructor', owner.email),
        buyer: await e2e.login('student', buyer.email),
        stranger: await e2e.login('student', stranger.email),
        unverified: await e2e.login('student', unverified.email),
      },
      published,
    };
  });

  afterAll(async () => {
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

  /* ------------------------------------------------------------------ happy path */

  let paidOrderId = '';

  it('checkout -> emulator pays -> signed webhook over HTTP -> PAID -> enrolled -> the locked lecture plays', async (ctx) => {
    skip(ctx);
    const { tokens, published } = fixtures();
    const buyer = e2e.as('student', tokens.buyer.accessToken);
    const master = `${V1}/catalog/courses/${published.courseId}/lectures/${published.lockedVideoId}/hls/master.m3u8`;
    expectProblem(await buyer.get(master), 403, ErrorCode.LectureLocked);

    await buyer.put(`${V1}/me/cart/items/${published.courseId}`).expect(200);
    const total = await cartTotal(buyer);
    expect(total).toBe('19.99');
    const key = randomUUID();
    const placed = CheckoutResponseSchema.parse(
      (await postCheckout(buyer, total, key).expect(201)).body,
    );
    expect(placed.status).toBe('PENDING_PAYMENT');
    expect(new URL(placed.checkoutUrl ?? '').origin).toBe(env.emulatorUrl);
    paidOrderId = placed.orderId;

    // Resume by key: the same order and session; no second order.
    expect((await postCheckout(buyer, total, key).expect(201)).body).toEqual(placed);
    const pending = OrderDetailSchema.parse(
      (await buyer.get(`${V1}/me/orders/${placed.orderId}`).expect(200)).body,
    );
    expect(pending).toMatchObject({
      status: 'PENDING_PAYMENT',
      checkoutUrl: placed.checkoutUrl,
      payment: { provider: 'STRIPE', status: 'OPEN' },
    });
    expectProblem(
      await buyer.get(`${V1}/me/orders/${placed.orderId}/receipt`),
      409,
      ErrorCode.OrderNotPaid,
    );

    const sessionId = sessionIdOf(placed.checkoutUrl);
    const paid = await control(`/checkout/sessions/${sessionId}/complete`);
    expect(String(paid.redirectUrl)).toBe(
      `http://localhost:3000/checkout/success?orderId=${placed.orderId}`,
    );
    await drain();

    const detail = OrderDetailSchema.parse(
      (await buyer.get(`${V1}/me/orders/${placed.orderId}`).expect(200)).body,
    );
    expect(detail).toMatchObject({
      status: 'PAID',
      checkoutUrl: null,
      payment: { status: 'SUCCEEDED' },
      totalAmount: '19.99',
    });
    expect(detail.lines[0]).toMatchObject({
      courseId: published.courseId,
      slug: published.slug,
      refund: { eligible: true },
    });
    const ok = await buyer.get(master).expect(200);
    expect(ok.text).toContain('#EXTM3U');

    const receipt = ReceiptSchema.parse(
      (await buyer.get(`${V1}/me/orders/${placed.orderId}/receipt`).expect(200)).body,
    );
    expect(receipt).toMatchObject({
      orderId: placed.orderId,
      paymentProvider: 'STRIPE',
      buyer: { displayName: `Buyer ${tag}` },
    });
    const page = OrderSummaryPageSchema.parse(
      (await buyer.get(`${V1}/me/orders`).expect(200)).body,
    );
    expect(page.items.map((i) => i.id)).toEqual([placed.orderId]);
    expect(
      await postCheckout(buyer, total, key)
        .expect(201)
        .then((r) => r.body),
    ).toEqual({ orderId: placed.orderId, status: 'PAID', checkoutUrl: null });
  });

  it('a duplicate delivery (emulator redeliver, same id and bytes) is processed once; tampered redeliveries are 400', async (ctx) => {
    skip(ctx);
    expect(paidOrderId).not.toBe('');
    const events = await emulatorEvents('checkout.session.completed');
    const ours = events.filter((e) => e.status === 'delivered');
    const session = await e2e.pg.db
      .selectFrom('commerce.payments')
      .select('checkoutSessionId')
      .where('orderId', '=', paidOrderId)
      .executeTakeFirstOrThrow();
    const event = ours.find((e) => e.objectId === session.checkoutSessionId);
    expect(event).toBeDefined();
    const again = await control(`/events/${event?.id ?? ''}/redeliver`);
    expect(again.attempt).toMatchObject({ statusCode: 200 });
    for (const tamper of ['payload', 'signature', 'stale_timestamp'] as const) {
      const bad = await control(`/events/${event?.id ?? ''}/redeliver`, { tamper });
      expect(bad.attempt, tamper).toMatchObject({ statusCode: 400 });
    }
    const claims = await e2e.pg.db
      .selectFrom('commerce.providerEvents')
      .select(['eventId', 'outcome'])
      .where('eventId', '=', event?.id ?? '')
      .execute();
    expect(claims).toEqual([{ eventId: event?.id, outcome: 'APPLIED' }]);
    const paidEvents = await e2e.pg.db
      .selectFrom('outbox.events')
      .select('id')
      .where('aggregateId', '=', paidOrderId)
      .where('type', '=', 'OrderPaid.v1')
      .execute();
    expect(paidEvents).toHaveLength(1);
  });

  /* ------------------------------------------------------------------ authorization matrix */

  const ROUTES: readonly {
    readonly template: string;
    readonly method: HttpMethod;
    readonly path: () => string;
    readonly body?: object;
  }[] = [
    {
      template: `${V1}/me/checkout`,
      method: 'post',
      path: () => `${V1}/me/checkout`,
      body: { expectedTotal: '0.00' },
    },
    { template: `${V1}/me/orders`, method: 'get', path: () => `${V1}/me/orders` },
    {
      template: `${V1}/me/orders/{orderId}`,
      method: 'get',
      path: () => `${V1}/me/orders/${paidOrderId}`,
    },
    {
      template: `${V1}/me/orders/{orderId}/receipt`,
      method: 'get',
      path: () => `${V1}/me/orders/${paidOrderId}/receipt`,
    },
    {
      template: `${V1}/me/orders/{orderId}/cancel`,
      method: 'post',
      path: () => `${V1}/me/orders/${paidOrderId}/cancel`,
    },
    { template: WEBHOOK, method: 'post', path: () => WEBHOOK, body: { id: 'evt_x' } },
  ];

  /** Status per route and caller (the buyer owns `paidOrderId`, a PAID order). */
  const MATRIX: Readonly<Record<string, Readonly<Record<Who, number>>>> = {
    [`POST ${V1}/me/checkout`]: {
      anonymous: 401,
      buyerViaInstructorApp: 401,
      instructor: 403,
      admin: 403,
      stranger: 422,
      buyer: 422,
    },
    [`GET ${V1}/me/orders`]: {
      anonymous: 401,
      buyerViaInstructorApp: 401,
      instructor: 403,
      admin: 403,
      stranger: 200,
      buyer: 200,
    },
    [`GET ${V1}/me/orders/{orderId}`]: {
      anonymous: 401,
      buyerViaInstructorApp: 401,
      instructor: 403,
      admin: 404,
      stranger: 404,
      buyer: 200,
    },
    [`GET ${V1}/me/orders/{orderId}/receipt`]: {
      anonymous: 401,
      buyerViaInstructorApp: 401,
      instructor: 403,
      admin: 404,
      stranger: 404,
      buyer: 200,
    },
    [`POST ${V1}/me/orders/{orderId}/cancel`]: {
      anonymous: 401,
      buyerViaInstructorApp: 401,
      instructor: 403,
      admin: 404,
      stranger: 404,
      buyer: 409,
    },
    // Public ingress: credentials are irrelevant, only a valid signature counts.
    [`POST ${WEBHOOK}`]: {
      anonymous: 400,
      buyerViaInstructorApp: 400,
      instructor: 400,
      admin: 400,
      stranger: 400,
      buyer: 400,
    },
  };

  it('the matrix covers exactly SECTION_8_PHASE_4_COMMERCE_B', () => {
    const covered = ROUTES.map((r) => `${r.method.toUpperCase()} ${r.template}`).sort();
    expect(covered).toEqual(
      SECTION_8_PHASE_4_COMMERCE_B.map(([p, m]) => `${m.toUpperCase()} ${p}`).sort(),
    );
    expect(Object.keys(MATRIX).sort()).toEqual(covered);
  });

  it('auth matrix: every route x anonymous / buyer / another student / instructor app / admin / buyer token via the instructor app', async (ctx) => {
    skip(ctx);
    expect(paidOrderId).not.toBe('');
    const codes: Record<number, string | undefined> = {
      400: undefined,
      401: 'unauthorized',
      403: ErrorCode.Forbidden,
      404: undefined,
      409: ErrorCode.OrderNotCancelable,
      422: ErrorCode.CartEmpty,
    };
    for (const route of ROUTES) {
      const expected = MATRIX[`${route.method.toUpperCase()} ${route.template}`] ?? {};
      for (const [who, status] of Object.entries(expected) as [Who, number][]) {
        const base = call(who, route.method, route.path());
        const req = route.template.endsWith('/me/checkout')
          ? base.set('Idempotency-Key', randomUUID())
          : base;
        const res = await (route.body === undefined ? req : req.send(route.body));
        expect(
          res.status,
          `${route.method} ${route.template} as ${who}: ${JSON.stringify(res.body)}`,
        ).toBe(status);
        if (status >= 400)
          expectProblem(
            res,
            status,
            route.template === WEBHOOK ? ErrorCode.WebhookSignatureInvalid : codes[status],
          );
      }
    }
    // Without any credentials, the webhook is still reachable (it answers 400, not 401).
    expectProblem(
      await e2e.http().post(WEBHOOK).send({ id: 'evt_x' }),
      400,
      ErrorCode.WebhookSignatureInvalid,
    );
  });

  /* ------------------------------------------------------------------ checkout errors */

  it('checkout errors over HTTP: idempotency_key_required, validation, email_not_verified, cart_empty, price_changed, cart_changed, idempotency_key_reused', async (ctx) => {
    skip(ctx);
    const { tokens } = fixtures();
    const unverified = e2e.as('student', tokens.unverified.accessToken);
    expectProblem(await postCheckout(unverified, '0.00'), 403, ErrorCode.EmailNotVerified);

    const { http } = await student('errors');
    expectProblem(await postCheckout(http, '0.00', null), 400, ErrorCode.IdempotencyKeyRequired);
    expectProblem(await postCheckout(http, '0.00', 'not-a-uuid'), 400, ErrorCode.ValidationFailed);
    expectProblem(await postCheckout(http, '1'), 400, ErrorCode.ValidationFailed);
    expectProblem(await postCheckout(http, '0.00'), 422, ErrorCode.CartEmpty);

    const c = await course('24.99');
    await http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
    const changed = expectProblem(await postCheckout(http, '19.99'), 409, ErrorCode.PriceChanged);
    expect(PriceChangedProblemSchema.parse(changed).quote.totals.totalAmount).toBe('24.99');

    const gone = await course('19.99');
    await http.put(`${V1}/me/cart/items/${gone.courseId}`).expect(200);
    await e2e.pg.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('commerce.coursePrices')
        .set({ amount: '0.00' })
        .where('courseId', '=', gone.courseId)
        .execute();
    });
    const cartChanged = expectProblem(
      await postCheckout(http, '24.99'),
      409,
      ErrorCode.CartChanged,
    );
    expect(
      CartChangedProblemSchema.parse(cartChanged).quote.unavailable.map((u) => u.reason),
    ).toEqual([ErrorCode.CourseIsFree]);
    await http.delete(`${V1}/me/cart/items/${gone.courseId}`).expect(200);

    const key = randomUUID();
    await postCheckout(http, '24.99', key).expect(201);
    expectProblem(await postCheckout(http, '19.99', key), 422, ErrorCode.IdempotencyKeyReused);
  });

  it('checkout_in_progress {orderId, checkoutUrl}; cancel expires the emulator session (200, repeatable); a new checkout is then allowed', async (ctx) => {
    skip(ctx);
    const { http } = await student('cancel');
    const c = await course('29.99');
    await http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
    const first = CheckoutResponseSchema.parse(
      (await postCheckout(http, '29.99').expect(201)).body,
    );
    const busy = CheckoutInProgressProblemSchema.parse(
      expectProblem(await postCheckout(http, '29.99'), 409, ErrorCode.CheckoutInProgress),
    );
    expect(busy).toMatchObject({ orderId: first.orderId, checkoutUrl: first.checkoutUrl });

    const canceled = OrderDetailSchema.parse(
      (await http.post(`${V1}/me/orders/${first.orderId}/cancel`).expect(200)).body,
    );
    expect(canceled).toMatchObject({
      status: 'CANCELED',
      checkoutUrl: null,
      payment: { status: 'EXPIRED' },
    });
    const session = await fetch(
      `${env.emulatorUrl}/v1/checkout/sessions/${sessionIdOf(first.checkoutUrl)}`,
      {
        headers: { authorization: `Bearer ${env.secretKey}` },
      },
    );
    expect(((await session.json()) as { status: string }).status).toBe('expired');
    await drain(); // the emulator's checkout.session.expired arrives: a no-op now
    expect(
      (await http.post(`${V1}/me/orders/${first.orderId}/cancel`).expect(200)).body.status,
    ).toBe('CANCELED');
    await postCheckout(http, '29.99').expect(201);
  });

  it('zero-total checkout (100% coupon): 201 PAID without a session, enrolled at once', async (ctx) => {
    skip(ctx);
    const { http, user } = await student('zero');
    const c = await course('49.99');
    const code = testCouponCode('ZERO');
    await insertTestCoupon(e2e.pg.db, {
      createdBy: fixtures().users.owner.userId,
      courseId: c.courseId,
      code,
      percentOff: 100,
    });
    await http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
    await http.put(`${V1}/me/cart/coupon`).send({ code }).expect(200);
    const result = CheckoutResponseSchema.parse(
      (await postCheckout(http, '0.00').expect(201)).body,
    );
    expect(result).toMatchObject({ status: 'PAID', checkoutUrl: null });
    const enrollment = await e2e.pg.db
      .selectFrom('enrollment.enrollments')
      .select(['status', 'source'])
      .where('userId', '=', user.userId)
      .where('courseId', '=', c.courseId)
      .executeTakeFirstOrThrow();
    expect(enrollment).toEqual({ status: 'ACTIVE', source: 'ORDER' });
    expect(
      ReceiptSchema.parse(
        (await http.get(`${V1}/me/orders/${result.orderId}/receipt`).expect(200)).body,
      ).paymentProvider,
    ).toBe('NONE');
  });

  /* ------------------------------------------------------------------ webhook security */

  it('webhook signatures: missing, wrong secret, stale, re-serialized and non-JSON bodies are 400 without detail; a valid unhandled event is 200', async (ctx) => {
    skip(ctx);
    const event = stripeEvent('customer.created', { id: `cus_${tag}` });
    eventIds.push(event.id);
    const signed = signedWebhookRequest(event, env.webhookSecret);
    const post = () => e2e.http().post(WEBHOOK);

    const missing = expectProblem(
      await post().set('content-type', 'application/json').send(signed.body.toString('utf8')),
      400,
      ErrorCode.WebhookSignatureInvalid,
    );
    expect(missing.detail).toBeUndefined();
    expectProblem(
      await post()
        .set({
          'content-type': 'application/json',
          'stripe-signature': signTestWebhook(signed.body, 'whsec_not_the_endpoint_secret'),
        })
        .send(signed.body.toString('utf8')),
      400,
      ErrorCode.WebhookSignatureInvalid,
    );
    expectProblem(
      await post()
        .set({
          'content-type': 'application/json',
          'stripe-signature': signTestWebhook(
            signed.body,
            env.webhookSecret,
            Math.floor(Date.now() / 1000) - 600,
          ),
        })
        .send(signed.body.toString('utf8')),
      400,
      ErrorCode.WebhookSignatureInvalid,
    );
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(signed.body.toString('utf8')), null, 2),
      'utf8',
    );
    expectProblem(
      await post().set(signed.headers).send(reserialized.toString('utf8')),
      400,
      ErrorCode.WebhookSignatureInvalid,
    );
    expectProblem(
      await post()
        .set({ ...signed.headers, 'content-type': 'text/plain' })
        .send(signed.body.toString('utf8')),
      400,
      ErrorCode.WebhookSignatureInvalid,
    );
    // Nothing was claimed by the rejected deliveries.
    expect(
      await e2e.pg.db
        .selectFrom('commerce.providerEvents')
        .select('eventId')
        .where('eventId', '=', event.id)
        .execute(),
    ).toEqual([]);

    const ok = await post().set(signed.headers).send(signed.body.toString('utf8')).expect(200);
    expect(WebhookAckSchema.parse(ok.body)).toEqual({ received: true });
    expect(
      await post()
        .set(signed.headers)
        .send(signed.body.toString('utf8'))
        .expect(200)
        .then((r) => r.body),
    ).toEqual({ received: true });
    expect(
      await e2e.pg.db
        .selectFrom('commerce.providerEvents')
        .select(['eventId', 'outcome'])
        .where('eventId', '=', event.id)
        .execute(),
    ).toEqual([{ eventId: event.id, outcome: 'IGNORED' }]);
  });

  it('amount mismatch over HTTP: a signed completed event charging another amount -> PAYMENT_REVIEW, no enrollment', async (ctx) => {
    skip(ctx);
    const { http, user } = await student('mismatch');
    const c = await course('19.99');
    await http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
    const placed = CheckoutResponseSchema.parse(
      (await postCheckout(http, '19.99').expect(201)).body,
    );
    const event = stripeEvent('checkout.session.completed', {
      id: sessionIdOf(placed.checkoutUrl),
      object: 'checkout.session',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 999,
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
    expect((await http.get(`${V1}/me/orders/${placed.orderId}`).expect(200)).body.status).toBe(
      'PAYMENT_REVIEW',
    );
    const enrolled = await e2e.pg.db
      .selectFrom('enrollment.enrollments')
      .select('id')
      .where('userId', '=', user.userId)
      .execute();
    expect(enrolled).toEqual([]);
    const alerts = await e2e.pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', placed.orderId)
      .where('type', '=', 'OrderPaymentMismatch.v1')
      .execute();
    expect(alerts).toHaveLength(1);
  });

  /* ------------------------------------------------------------------ reconcile */

  it('reconcile against the emulator: an OPEN session overdue in our books is expired at the provider and the order EXPIRED', async (ctx) => {
    skip(ctx);
    const { http, user } = await student('reconcile');
    const c = await course('19.99');
    await http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
    const placed = CheckoutResponseSchema.parse(
      (await postCheckout(http, '19.99').expect(201)).body,
    );
    await e2e.pg.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`
        UPDATE commerce.payments
           SET created_at = created_at - interval '60 minutes',
               session_expires_at = session_expires_at - interval '60 minutes'
         WHERE order_id = ${placed.orderId}
      `.execute(trx);
    });
    // Only this test's order is reconciled (a shared dev database may hold others).
    const repo = get(ReconcileRepository);
    const stale = repo.findStaleCreating.bind(repo);
    const overdue = repo.findOverdueOpen.bind(repo);
    const staleSpy = vi
      .spyOn(repo, 'findStaleCreating')
      .mockImplementation(async (ex, o) =>
        (await stale(ex, o)).filter((r) => r.userId === user.userId),
      );
    const overdueSpy = vi
      .spyOn(repo, 'findOverdueOpen')
      .mockImplementation(async (ex, o) =>
        (await overdue(ex, o)).filter((r) => r.userId === user.userId),
      );
    try {
      expect(await get(CommerceJobs).reconcile()).toEqual({
        locked: true,
        abandoned: 0,
        completed: 0,
        expired: 1,
        skipped: 0,
      });
    } finally {
      staleSpy.mockRestore();
      overdueSpy.mockRestore();
    }
    expect((await http.get(`${V1}/me/orders/${placed.orderId}`).expect(200)).body.status).toBe(
      'EXPIRED',
    );
    await drain(); // the emulator's own checkout.session.expired: deduped by state
    const outcomes = await e2e.pg.db
      .selectFrom('commerce.providerEvents')
      .select(['eventId', 'outcome'])
      .where('orderId', '=', placed.orderId)
      .orderBy('receivedAt')
      .execute();
    // The reconciler's synthetic event and the emulator's checkout.session.expired webhook
    // (sent when the reconciler expired the session) race: one applies, the other is a no-op.
    const synthetic = `reconcile:${sessionIdOf(placed.checkoutUrl)}:EXPIRED`;
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.eventId)).toContain(synthetic);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['APPLIED', 'DUPLICATE_EFFECT']);
  });
});
