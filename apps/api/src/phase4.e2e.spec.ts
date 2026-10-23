// Must stay the first import: AppModule validates process.env when it is imported.
import { COMMERCE_C_E2E_ENV } from './modules/commerce/testing/apply-commerce-c-e2e-env';
import { createHmac, randomUUID } from 'node:crypto';
import {
  type AuthResult,
  AuthResultSchema,
  CartQuoteSchema,
  CheckoutInProgressProblemSchema,
  CheckoutResponseSchema,
  ErrorCode,
  OrderDetailSchema,
  OrderPaid,
  OrderSummaryPageSchema,
  PurchaseStatesResponseSchema,
  RecentSalePageSchema,
  RefundDecisionResponseSchema,
  RefundSchema,
  RefundSucceeded,
  SalesSummarySchema,
} from '@udemy/contracts';
import { getLedgerTotals, postRefundEntry, postSaleEntry, reconcileLedger, sql } from '@udemy/db';
import {
  checkoutSessionCompletedEvent,
  checkoutSessionExpiredEvent,
  signedWebhookRequest,
  signTestWebhook,
} from '@udemy/payments/testing';
import {
  emulatorConfig,
  type RunningEmulator,
  silentLogger,
  startEmulator,
} from '@udemy/stripe-emulator';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceJobs } from './modules/commerce/application/commerce-jobs';
import { CommerceSettings } from './modules/commerce/application/commerce-settings';
import { ReconcileRepository } from './modules/commerce/application/ports/reconcile.repository';
import { RefundDispatcher } from './modules/commerce/application/refund-dispatcher.service';
import { HandleProviderEventCommand } from './modules/commerce/application/use-cases/handle-provider-event.command';
import { commerceRateLimitKeys } from './modules/commerce/infrastructure/redis-commerce-rate-limiter';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  deleteProviderEvents,
  insertTestCoupon,
  insertTestCourse,
  insertTestEnrollment,
  insertTestRedemption,
  setTestCourseStatus,
  setTestPrice,
  type TestCourse,
  testCouponCode,
} from './modules/commerce/testing/commerce-it';
import {
  type BearerClient,
  E2E_PASSWORD,
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from './testing/e2e/e2e-harness';
import {
  type Operation,
  SECTION_8,
  SECTION_8_PHASE_1,
  SECTION_8_PHASE_2,
  SECTION_8_PHASE_4,
} from './testing/e2e/section-8';

/*
 * P4-T17: the consolidated Phase 4 API sweep. Every Phase 4 task has its own e2e/integration
 * file (enrollment, commerce A/B/C, checkout, refunds); this file closes the gaps found by the
 * coverage audit (docs/phase-4-api-e2e-coverage.md) through the REAL AppModule listening on a
 * free port, with `apps/stripe-emulator` in-process on another free port (the real
 * `StripePaymentProvider`, signed webhooks over HTTP, the post-commit refund kick):
 *
 * - SECTION_8's Phase 4 part equals what Swagger documents AND what Express serves;
 * - the §9 IDOR matrix in one place: student B with every id of student A (orders, receipts,
 *   cancel, refunds, A's line inside B's order, A's idempotency key), instructor B with every
 *   id of instructor A (pricing, coupons, A's coupon under B's course, sales), and the app/role
 *   boundaries; every refusal is a 404 (or the documented 403/401) and nothing of A changes;
 * - the §9 concurrency list over HTTP (N=20 coupon race, same key / two keys in parallel,
 *   concurrent duplicate webhooks, expired after completed, late completed after cancel with
 *   and without a duplicate auto-refund, refund request racing an admin refund);
 * - the refund lifecycle as a state table (SUBMITTED -> FAILED -> retry -> SUCCEEDED, every
 *   illegal admin action is 409);
 * - the §8 error codes no other e2e file sends over HTTP;
 * - webhook security additions (future timestamp, malformed header, rolled secret, livemode,
 *   orphan, unpaid);
 * - reconcile against the emulator: a lost webhook is recovered (b), an outage leaves CREATING
 *   (503), the same key resumes it, and a stale CREATING is abandoned (a);
 * - the ledger reconciliation query (D13): the API's OrderPaid / RefundSucceeded outbox events
 *   of this file, posted with the same `@udemy/db` payouts operations as the worker's
 *   `payouts.ledger-writer`, leave no difference.
 *
 * Every row and rate-limit key the file creates is removed in afterAll. No wall-clock upper
 * bounds anywhere. The timers of CommerceJobs are parked (1 day); reconcile runs are scoped to
 * this file's buyers, so other rows of a shared dev database are never touched.
 */
const V1 = '/api/v1';
const WEBHOOK = `${V1}/webhooks/stripe`;
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const env = COMMERCE_C_E2E_ENV;
const DAY_MS = 86_400_000;
const REASON = 'Phase 4 sweep: support action with a reason.';
const SLOW_MS = 180_000;

interface Student {
  readonly user: SignedUpUser;
  readonly http: BearerClient;
  readonly token: AuthResult;
}

interface Paid {
  readonly orderId: string;
  readonly sessionId: string;
  line(courseId: string): string;
}

interface Fixtures {
  readonly admin: SignedUpUser;
  readonly adminToken: AuthResult;
  readonly instructorA: SignedUpUser;
  readonly instructorAToken: AuthResult;
  readonly instructorB: SignedUpUser;
  readonly instructorBToken: AuthResult;
  readonly studentA: Student;
  readonly studentB: Student;
  /** Courses of instructor A (a1, a2 bought by student A; a3 in A's pending order). */
  readonly a1: TestCourse;
  readonly a2: TestCourse;
  readonly a3: TestCourse;
  /** A course of instructor B, bought by student B. */
  readonly b1: TestCourse;
  readonly couponOfA: string;
  readonly couponOfB: string;
  /** Student A's PAID order (a1 + a2). */
  readonly paidOfA: Paid;
  /** Student A's PENDING_PAYMENT order (a3) and the idempotency key that placed it. */
  readonly pendingOfA: { orderId: string; sessionId: string; key: string; lineId: string };
  /** Student B's PAID order (b1). */
  readonly paidOfB: Paid;
}

const op = ([path, method]: Operation): string => `${method.toUpperCase()} ${path}`;

describe('Phase 4 API sweep (e2e: AppModule over HTTP, stripe-emulator, Postgres, Redis)', () => {
  const e2e: E2eHarness = useE2eApp();
  const courseIds: string[] = [];
  const extraUsers: SignedUpUser[] = [];
  const eventIds: string[] = [];
  const couponIps = new Set<string>();
  let platformAccountsBefore: string[] = [];
  let emulator: RunningEmulator | undefined;
  let fx: Fixtures | undefined;

  const available = (): boolean => e2e.pg.available && e2e.redis.available;
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => e2e.skip(ctx);
  const get = <T>(token: abstract new (...args: never[]) => T): T =>
    e2e.app.get(token, { strict: false });
  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  /** Users created outside `student()`: the admin and the two instructors. */
  const staffUsers: SignedUpUser[] = [];
  const allUsers = (): SignedUpUser[] => [...staffUsers, ...extraUsers];

  const adminHttp = (): BearerClient => e2e.as('admin', fixtures().adminToken.accessToken);
  const instructorA = (): BearerClient =>
    e2e.as('instructor', fixtures().instructorAToken.accessToken);
  const instructorB = (): BearerClient =>
    e2e.as('instructor', fixtures().instructorBToken.accessToken);

  /* ------------------------------------------------------------------------ helpers */

  function emulatorSettings() {
    return emulatorConfig({
      secretKey: env.secretKey,
      webhookSecret: env.webhookSecret,
      webhookUrl: env.webhookUrl,
      publicUrl: env.emulatorUrl,
      webhookMaxAttempts: 3,
      webhookRetryBaseMs: 50,
      webhookRetryMaxMs: 200,
    });
  }

  async function bootEmulator(): Promise<void> {
    emulator = await startEmulator(
      emulatorSettings(),
      { port: env.emulatorPort, host: '127.0.0.1' },
      { logger: silentLogger },
    );
  }

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

  async function emulatorSession(sessionId: string): Promise<{ status: string }> {
    const res = await fetch(`${env.emulatorUrl}/v1/checkout/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${env.secretKey}` },
    });
    return (await res.json()) as { status: string };
  }

  async function emulatorSessionsOf(
    orderId: string,
  ): Promise<{ id: string; status: string; client_reference_id: string | null }[]> {
    const res = await fetch(`${env.emulatorUrl}/_emulator/state`);
    const state = (await res.json()) as {
      sessions: { id: string; status: string; client_reference_id: string | null }[];
    };
    return state.sessions.filter((s) => s.client_reference_id === orderId);
  }

  /** Every kick has finished, then every webhook the emulator queued has been delivered. */
  async function settle(): Promise<void> {
    await get(RefundDispatcher).whenIdle();
    expect((await control('/webhooks/drain?timeoutMs=20000')).idle).toBe(true);
    await get(RefundDispatcher).whenIdle();
  }

  /**
   * A fresh, verified student with a session in the student app, signed up and logged in from
   * its OWN TEST-NET address (the per-IP signup/login/coupon limits never bite, even for the
   * N=20 race). Tracked by email, so the harness removes the user and its keys.
   */
  async function student(label: string): Promise<Student> {
    const ip = await e2e.freshIp();
    couponIps.add(ip);
    const email = e2e.newEmail(`p4-${label}`);
    const headers = e2e.client('student', { ip });
    await e2e
      .http()
      .post(`${V1}/auth/signup`)
      .set(headers)
      .send({ email, password: E2E_PASSWORD, displayName: `P4 ${label}` })
      .expect(202);
    const row = await e2e.pg.db
      .selectFrom('identity.users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    e2e.track(row.id);
    await e2e.verifyEmailViaSql(row.id);
    const login = await e2e
      .http()
      .post(`${V1}/auth/login`)
      .set(headers)
      .send({ email, password: E2E_PASSWORD })
      .expect(200);
    const token = AuthResultSchema.parse(login.body);
    const user: SignedUpUser = { userId: row.id, email, password: E2E_PASSWORD };
    extraUsers.push(user);
    return { user, token, http: e2e.as('student', token.accessToken, { ip }) };
  }

  async function course(price: string | null, ownerId?: string): Promise<TestCourse> {
    const owner = ownerId ?? fixtures().instructorA.userId;
    const created = await insertTestCourse(e2e.pg.db, { ownerId: owner });
    courseIds.push(created.courseId);
    if (price !== null) await setTestPrice(e2e.pg.db, created.courseId, price, owner);
    return created;
  }

  const sessionIdOf = (checkoutUrl: string | null): string => {
    const match = /\/pay\/(cs_test_[A-Za-z0-9]+)$/.exec(checkoutUrl ?? '');
    if (match?.[1] === undefined) throw new Error(`not an emulator checkout url: ${checkoutUrl}`);
    return match[1];
  };

  async function cartTotal(http: BearerClient): Promise<string> {
    return CartQuoteSchema.parse((await http.get(`${V1}/me/cart`).expect(200)).body).totals
      .totalAmount;
  }

  function postCheckout(http: BearerClient, expectedTotal: string, key: string = randomUUID()) {
    return http.post(`${V1}/me/checkout`).set('Idempotency-Key', key).send({ expectedTotal });
  }

  async function placeOrder(
    http: BearerClient,
    ids: readonly string[],
    options: { code?: string; key?: string } = {},
  ): Promise<{ orderId: string; sessionId: string; key: string }> {
    for (const id of ids) await http.put(`${V1}/me/cart/items/${id}`).expect(200);
    if (options.code !== undefined) {
      await http.put(`${V1}/me/cart/coupon`).send({ code: options.code }).expect(200);
    }
    const key = options.key ?? randomUUID();
    const placed = CheckoutResponseSchema.parse(
      (await postCheckout(http, await cartTotal(http), key).expect(201)).body,
    );
    expect(placed.status).toBe('PENDING_PAYMENT');
    return { orderId: placed.orderId, sessionId: sessionIdOf(placed.checkoutUrl), key };
  }

  async function linesOf(orderId: string): Promise<{ id: string; courseId: string }[]> {
    return e2e.pg.db
      .selectFrom('commerce.orderLines')
      .select(['id', 'courseId'])
      .where('orderId', '=', orderId)
      .execute();
  }

  function paidView(orderId: string, sessionId: string, lines: { id: string; courseId: string }[]) {
    return {
      orderId,
      sessionId,
      line: (courseId: string): string => {
        const found = lines.find((l) => l.courseId === courseId);
        if (found === undefined) throw new Error(`no line for ${courseId}`);
        return found.id;
      },
    };
  }

  /** Checkout -> emulator "Pay" -> signed webhook over HTTP -> PAID. */
  async function buy(http: BearerClient, ids: readonly string[], code?: string): Promise<Paid> {
    const placed = await placeOrder(http, ids, code === undefined ? {} : { code });
    await control(`/checkout/sessions/${placed.sessionId}/complete`);
    await settle();
    expect(await orderStatus(placed.orderId)).toBe('PAID');
    return paidView(placed.orderId, placed.sessionId, await linesOf(placed.orderId));
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

  async function outboxCount(aggregateId: string, type: string): Promise<number> {
    const rows = await e2e.pg.db
      .selectFrom('outbox.events')
      .select('id')
      .where('aggregateId', '=', aggregateId)
      .where('type', '=', type)
      .execute();
    return rows.length;
  }

  async function claimsOf(orderId: string): Promise<{ eventId: string; outcome: string | null }[]> {
    return e2e.pg.db
      .selectFrom('commerce.providerEvents')
      .select(['eventId', 'outcome'])
      .where('orderId', '=', orderId)
      .orderBy('receivedAt')
      .execute();
  }

  async function orderTotalMinor(orderId: string): Promise<number> {
    const row = await e2e.pg.db
      .selectFrom('commerce.orders')
      .select('totalAmount')
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
    return Math.round(Number(row.totalAmount) * 100);
  }

  /** POSTs the exact signed bytes of `event` to the webhook (no client credentials at all). */
  function deliver(event: { id: string }, timestamp?: number): request.Test {
    eventIds.push(event.id);
    const signed = signedWebhookRequest(event, env.webhookSecret, timestamp);
    return e2e.http().post(WEBHOOK).set(signed.headers).send(signed.body.toString('utf8'));
  }

  const fakePaymentIntent = (): string => `pi_${randomUUID().replace(/-/g, '')}`;

  function postRefund(http: BearerClient, orderId: string, orderLineId: string): request.Test {
    return http
      .post(`${V1}/me/orders/${orderId}/refunds`)
      .send({ orderLineId, reasonCode: 'NOT_AS_EXPECTED', comment: 'Not for me.' });
  }

  async function refundRow(refundId: string) {
    return e2e.pg.db
      .selectFrom('commerce.refunds')
      .select(['status', 'attempt', 'providerRefundId', 'initiatedBy', 'reasonCode'])
      .where('id', '=', refundId)
      .executeTakeFirstOrThrow();
  }

  /** Runs `work` with the post-commit kick switched off (approved refunds stay APPROVED). */
  async function withoutKick<T>(work: () => Promise<T>): Promise<T> {
    const settings = get(CommerceSettings);
    Object.defineProperty(settings, 'jobsEnabled', { value: false, configurable: true });
    try {
      return await work();
    } finally {
      Object.defineProperty(settings, 'jobsEnabled', { value: true, configurable: true });
    }
  }

  /** A full rate-limit bucket (the next hit is the first over the limit). */
  async function fillBucket(key: string, limit: number): Promise<void> {
    await e2e.redis.redis.set(key, String(limit), 'PX', 60_000);
  }

  /** CommerceJobs.reconcile, restricted to the payments of these buyers. */
  async function reconcileOnly(userIds: readonly string[]) {
    const repo = get(ReconcileRepository);
    const stale = repo.findStaleCreating.bind(repo);
    const overdue = repo.findOverdueOpen.bind(repo);
    const staleSpy = vi
      .spyOn(repo, 'findStaleCreating')
      .mockImplementation(async (ex, o) =>
        (await stale(ex, o)).filter((r) => userIds.includes(r.userId)),
      );
    const overdueSpy = vi
      .spyOn(repo, 'findOverdueOpen')
      .mockImplementation(async (ex, o) =>
        (await overdue(ex, o)).filter((r) => userIds.includes(r.userId)),
      );
    try {
      return await get(CommerceJobs).reconcile();
    } finally {
      staleSpy.mockRestore();
      overdueSpy.mockRestore();
    }
  }

  async function agePayment(orderId: string, minutes: number): Promise<void> {
    await e2e.pg.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      const back = sql`${minutes}::int * interval '1 minute'`;
      await sql`
        UPDATE commerce.payments
           SET created_at = created_at - ${back},
               session_expires_at = session_expires_at - ${back}
         WHERE order_id = ${orderId}
      `.execute(trx);
    });
  }

  /* ------------------------------------------------------------------------ fixtures */

  beforeAll(async () => {
    if (!available()) return;
    await bootEmulator();
    await e2e.app.listen(env.apiPort, '127.0.0.1');
    platformAccountsBefore = (
      await e2e.pg.db
        .selectFrom('payouts.accounts')
        .select('id')
        .where('ownerId', 'is', null)
        .execute()
    ).map((r) => r.id);

    const admin = await e2e.bootstrapAdmin();
    const insA = await e2e.signup({ displayName: 'P4 instructor A' });
    const insB = await e2e.signup({ displayName: 'P4 instructor B' });
    staffUsers.push(admin, insA, insB);
    for (const u of [insA, insB]) {
      await e2e.verifyEmailViaSql(u.userId);
      await e2e.promoteToInstructor(u.userId, admin.userId);
    }
    const adminToken = await e2e.login('admin', admin.email);
    const instructorAToken = await e2e.login('instructor', insA.email);
    const instructorBToken = await e2e.login('instructor', insB.email);
    const a1 = await course('19.99', insA.userId);
    const a2 = await course('24.99', insA.userId);
    const a3 = await course('29.99', insA.userId);
    const b1 = await course('24.99', insB.userId);
    const couponOfA = await insertTestCoupon(e2e.pg.db, {
      createdBy: insA.userId,
      courseId: a1.courseId,
      code: testCouponCode('P4A'),
      percentOff: 10,
    });
    const couponOfB = await insertTestCoupon(e2e.pg.db, {
      createdBy: insB.userId,
      courseId: b1.courseId,
      code: testCouponCode('P4B'),
      percentOff: 10,
    });
    const studentA = await student('student-a');
    const studentB = await student('student-b');

    const paidOfA = await buy(studentA.http, [a1.courseId, a2.courseId]);
    const pending = await placeOrder(studentA.http, [a3.courseId]);
    const pendingLine = (await linesOf(pending.orderId))[0]?.id ?? '';
    const paidOfB = await buy(studentB.http, [b1.courseId]);

    fx = {
      admin,
      adminToken,
      instructorA: insA,
      instructorAToken,
      instructorB: insB,
      instructorBToken,
      studentA,
      studentB,
      a1,
      a2,
      a3,
      b1,
      couponOfA,
      couponOfB,
      paidOfA,
      pendingOfA: { ...pending, lineId: pendingLine },
      paidOfB,
    };
  }, SLOW_MS);

  beforeEach(async () => {
    if (!available() || fx === undefined) return;
    const keys = commerceRateLimitTestKeys({ userIds: allUsers().map((u) => u.userId) });
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
  });

  // Registered after useE2eApp, so it runs BEFORE the harness teardown (which then deletes the
  // users, sessions, outbox rows of the users and the per-IP auth keys).
  afterAll(async () => {
    if (available()) await get(RefundDispatcher).whenIdle();
    await emulator?.close();
    if (!available() || fx === undefined) return;
    const db = e2e.pg.db;
    const ids = allUsers().map((u) => u.userId);
    const keys = commerceRateLimitTestKeys({ userIds: ids, courseIds, ips: [...couponIps] });
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
    // Orders (with their ledger entries, refunds, provider events), carts, coupons, prices,
    // enrollments and the test courses.
    await deleteCommerceTestData(db, { userIds: ids, courseIds, deleteUsers: false });
    await deleteProviderEvents(db, eventIds);
    // Ledger accounts created lazily for this file's instructors (and the platform accounts,
    // if this run created them and nothing else posts to them).
    await db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await trx.deleteFrom('payouts.accounts').where('ownerId', 'in', ids).execute();
      const created = await trx
        .selectFrom('payouts.accounts')
        .select('id')
        .where('ownerId', 'is', null)
        .execute();
      for (const { id } of created) {
        if (platformAccountsBefore.includes(id)) continue;
        const used = await trx
          .selectFrom('payouts.postings')
          .select('entryId')
          .where('accountId', '=', id)
          .limit(1)
          .execute();
        if (used.length === 0)
          await trx.deleteFrom('payouts.accounts').where('id', '=', id).execute();
      }
    });

    // Nothing of this file is left (so a second run starts clean).
    const left = await sql<{
      orders: string;
      courses: string;
      accounts: string;
      events: string;
      enrollments: string;
    }>`
      SELECT (SELECT count(*) FROM commerce.orders WHERE user_id = ANY(${ids}::uuid[])) AS orders,
             (SELECT count(*) FROM catalog.courses WHERE id = ANY(${courseIds}::uuid[])) AS courses,
             (SELECT count(*) FROM payouts.accounts WHERE owner_id = ANY(${ids}::uuid[])) AS accounts,
             (SELECT count(*) FROM commerce.provider_events WHERE event_id = ANY(${eventIds}::text[])) AS events,
             (SELECT count(*) FROM enrollment.enrollments WHERE user_id = ANY(${ids}::uuid[])) AS enrollments
    `.execute(db);
    expect(left.rows[0]).toEqual({
      orders: '0',
      courses: '0',
      accounts: '0',
      events: '0',
      enrollments: '0',
    });
    if (keys.length > 0) expect(await e2e.redis.redis.exists(...keys)).toBe(0);
  }, SLOW_MS);

  /* ------------------------------------------------------------------ SECTION_8 */

  describe('SECTION_8: the Phase 4 operations', () => {
    const phase4 = SECTION_8_PHASE_4.map(op).sort();
    const earlier = new Set([...SECTION_8_PHASE_1, ...SECTION_8_PHASE_2].map(op));
    const notPhase4 = new Set(SECTION_8.map(op).filter((o) => !phase4.includes(o)));

    it('has no duplicates and no overlap with Phases 1-2', () => {
      expect(new Set(phase4).size).toBe(phase4.length);
      expect(phase4.filter((o) => earlier.has(o))).toEqual([]);
    });

    it('equals the Phase 4 operations Swagger documents (no extras, no gaps)', async (ctx) => {
      skip(ctx);
      const res = await e2e.http().get('/api/docs-json').expect(200);
      const paths = (res.body as { paths: Record<string, Record<string, unknown>> }).paths;
      const documented = Object.entries(paths)
        .filter(([path]) => !path.startsWith('/api/health'))
        .flatMap(([path, item]) =>
          Object.keys(item)
            .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
            .map((method) => op([path, method])),
        )
        .filter((o) => !notPhase4.has(o))
        .sort();
      expect(documented).toEqual(phase4);
    });

    it('equals the Phase 4 routes Express serves (nothing undocumented hides)', (ctx) => {
      skip(ctx);
      const served = expressRoutes(e2e.app.getHttpAdapter().getInstance())
        .filter(([path]) => path.startsWith(`${V1}/`))
        .map(op)
        .filter((o) => !notPhase4.has(o));
      expect([...new Set(served)].sort()).toEqual(phase4);
    });
  });

  /* ------------------------------------------------------------------ IDOR matrix */

  describe('IDOR (§9): another user with ids of A', () => {
    /** Everything student B's requests could have touched of student A, from the database. */
    async function snapshotOfStudentA(): Promise<unknown> {
      const db = e2e.pg.db;
      const userId = fixtures().studentA.user.userId;
      const orderIds = [fixtures().paidOfA.orderId, fixtures().pendingOfA.orderId];
      return {
        orders: await db
          .selectFrom('commerce.orders')
          .select(['id', 'status', 'totalAmount', 'closedAt'])
          .where('userId', '=', userId)
          .orderBy('id')
          .execute(),
        payments: await db
          .selectFrom('commerce.payments')
          .select(['orderId', 'status', 'checkoutSessionId', 'checkoutUrl'])
          .where('orderId', 'in', orderIds)
          .orderBy('orderId')
          .execute(),
        transitions: await db
          .selectFrom('commerce.orderTransitions')
          .select(['orderId', 'toStatus'])
          .where('orderId', 'in', orderIds)
          .orderBy('orderId')
          .orderBy('occurredAt')
          .execute(),
        refunds: await db
          .selectFrom('commerce.refunds')
          .select(['id', 'status'])
          .where('orderId', 'in', orderIds)
          .execute(),
        enrollments: await db
          .selectFrom('enrollment.enrollments')
          .select(['courseId', 'status'])
          .where('userId', '=', userId)
          .orderBy('courseId')
          .execute(),
      };
    }

    it("student B with A's orders, receipt, cancel, refunds, A's line inside B's order and A's idempotency key: 404 (or no effect), nothing of A changes", async (ctx) => {
      skip(ctx);
      const { studentB, paidOfA, pendingOfA, paidOfB, a1, b1 } = fixtures();
      const before = await snapshotOfStudentA();
      const lineOfA = paidOfA.line(a1.courseId);
      const routes: (readonly [HttpMethod, string, object?])[] = [
        ['get', `${V1}/me/orders/${paidOfA.orderId}`],
        ['get', `${V1}/me/orders/${paidOfA.orderId}/receipt`],
        ['post', `${V1}/me/orders/${paidOfA.orderId}/cancel`],
        ['get', `${V1}/me/orders/${pendingOfA.orderId}`],
        ['get', `${V1}/me/orders/${pendingOfA.orderId}/receipt`],
        ['post', `${V1}/me/orders/${pendingOfA.orderId}/cancel`],
        [
          'post',
          `${V1}/me/orders/${paidOfA.orderId}/refunds`,
          { orderLineId: lineOfA, reasonCode: 'QUALITY' },
        ],
        [
          'post',
          `${V1}/me/orders/${pendingOfA.orderId}/refunds`,
          { orderLineId: pendingOfA.lineId, reasonCode: 'QUALITY' },
        ],
        // A's line inside B's OWN order, and B's line inside A's order.
        [
          'post',
          `${V1}/me/orders/${paidOfB.orderId}/refunds`,
          { orderLineId: lineOfA, reasonCode: 'QUALITY' },
        ],
        [
          'post',
          `${V1}/me/orders/${paidOfA.orderId}/refunds`,
          { orderLineId: paidOfB.line(b1.courseId), reasonCode: 'QUALITY' },
        ],
      ];
      const failures: string[] = [];
      for (const [method, path, body] of routes) {
        const req = studentB.http.call(method, path);
        const res = await (body === undefined ? req : req.send(body));
        if (res.status !== 404) failures.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
        else expectProblem(res, 404);
      }
      expect(failures).toEqual([]);

      // B's own list never shows A's orders.
      const mine = OrderSummaryPageSchema.parse(
        (await studentB.http.get(`${V1}/me/orders?limit=50`).expect(200)).body,
      );
      expect(mine.items.map((i) => i.id)).toEqual([paidOfB.orderId]);
      // A's idempotency key is scoped to A: B (empty cart) does not resume A's order.
      expectProblem(
        await postCheckout(studentB.http, '29.99', pendingOfA.key),
        422,
        ErrorCode.CartEmpty,
      );
      // B's cancel of A's pending order never reached the provider: A's session is still open.
      expect((await emulatorSession(pendingOfA.sessionId)).status).toBe('open');
      expect(await snapshotOfStudentA()).toEqual(before);
    });

    /** Everything instructor B's requests could have touched of instructor A, from the DB. */
    async function snapshotOfInstructorA(): Promise<unknown> {
      const db = e2e.pg.db;
      const { a1, couponOfA } = fixtures();
      return {
        price: await db
          .selectFrom('commerce.coursePrices')
          .select(['amount', 'updatedBy'])
          .where('courseId', '=', a1.courseId)
          .executeTakeFirst(),
        priceChanges: (
          await db
            .selectFrom('commerce.coursePriceChanges')
            .select('courseId')
            .where('courseId', '=', a1.courseId)
            .execute()
        ).length,
        coupons: await db
          .selectFrom('commerce.coupons')
          .select(['id', 'code', 'deactivatedAt'])
          .where('courseId', '=', a1.courseId)
          .orderBy('id')
          .execute(),
        events: (
          await db
            .selectFrom('outbox.events')
            .select('id')
            .where('aggregateId', 'in', [a1.courseId, couponOfA])
            .execute()
        ).length,
      };
    }

    it("instructor B with A's pricing, coupons and A's coupon under B's course: 404; B's sales never show A's", async (ctx) => {
      skip(ctx);
      const { a1, b1, couponOfA, couponOfB, paidOfA, paidOfB } = fixtures();
      const before = await snapshotOfInstructorA();
      const course = `${V1}/courses/${a1.courseId}`;
      const routes: (readonly [HttpMethod, string, object?])[] = [
        ['get', `${course}/pricing`],
        ['put', `${course}/pricing`, { amount: '29.99' }],
        ['get', `${course}/coupons`],
        [
          'post',
          `${course}/coupons`,
          {
            code: testCouponCode('HIJACK'),
            discountType: 'PERCENT',
            percentOff: 90,
            endsAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
          },
        ],
        ['post', `${course}/coupons/${couponOfA}/deactivate`],
        // A's coupon id under B's OWN course; B's coupon under A's course.
        ['post', `${V1}/courses/${b1.courseId}/coupons/${couponOfA}/deactivate`],
        ['post', `${course}/coupons/${couponOfB}/deactivate`],
      ];
      const failures: string[] = [];
      for (const [method, path, body] of routes) {
        const req = instructorB().call(method, path);
        const res = await (body === undefined ? req : req.send(body));
        if (res.status !== 404) failures.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
        else expectProblem(res, 404, ErrorCode.NotFound);
      }
      expect(failures).toEqual([]);
      // A course coupon is not addressable through the admin platform-coupon route either.
      expectProblem(await adminHttp().post(`${V1}/admin/coupons/${couponOfA}/deactivate`), 404);

      // Sales are scoped to the caller: A's course id filters B's sales down to nothing.
      const filtered = RecentSalePageSchema.parse(
        (await instructorB().get(`${V1}/instructor/sales?courseId=${a1.courseId}`).expect(200))
          .body,
      );
      expect(filtered.items).toEqual([]);
      const ownSales = RecentSalePageSchema.parse(
        (await instructorB().get(`${V1}/instructor/sales?limit=50`).expect(200)).body,
      );
      expect(ownSales.items.map((s) => s.orderLineId)).toEqual([paidOfB.line(b1.courseId)]);
      const from = encodeURIComponent(new Date(Date.now() - DAY_MS).toISOString());
      const to = encodeURIComponent(new Date(Date.now() + DAY_MS).toISOString());
      const summary = SalesSummarySchema.parse(
        (
          await instructorB()
            .get(`${V1}/instructor/sales/summary?from=${from}&to=${to}`)
            .expect(200)
        ).body,
      );
      expect(summary.courses.map((c) => c.courseId)).toEqual([b1.courseId]);
      // ...while A sees exactly A's two paid lines.
      const salesOfA = RecentSalePageSchema.parse(
        (await instructorA().get(`${V1}/instructor/sales?limit=50`).expect(200)).body,
      );
      expect(salesOfA.items.map((s) => s.orderLineId).sort()).toEqual(
        [paidOfA.line(a1.courseId), paidOfA.line(fixtures().a2.courseId)].sort(),
      );
      expect(await snapshotOfInstructorA()).toEqual(before);
    });

    it('app and role boundaries with real ids: student -> admin routes 403, instructor app -> /me routes 403, tokens replayed through another BFF 401', async (ctx) => {
      skip(ctx);
      const { studentA, paidOfA, a1, instructorAToken } = fixtures();
      const lineOfA = paidOfA.line(a1.courseId);
      const refundIdOfNobody = randomUUID();
      const adminRoutes: (readonly [HttpMethod, string, object?])[] = [
        ['get', `${V1}/admin/orders?userId=${studentA.user.userId}`],
        ['get', `${V1}/admin/orders/${paidOfA.orderId}`],
        [
          'post',
          `${V1}/admin/orders/${paidOfA.orderId}/refunds`,
          { orderLineIds: [lineOfA], reason: REASON },
        ],
        ['post', `${V1}/admin/orders/${paidOfA.orderId}/accept-payment`, { reason: REASON }],
        ['get', `${V1}/admin/refunds`],
        ['post', `${V1}/admin/refunds/${refundIdOfNobody}/approve`, {}],
        ['get', `${V1}/admin/users/${studentA.user.userId}/enrollments`],
        [
          'post',
          `${V1}/admin/enrollments`,
          { userId: studentA.user.userId, courseId: a1.courseId, reason: REASON },
        ],
        [
          'post',
          `${V1}/admin/coupons`,
          {
            code: testCouponCode('NOPE'),
            discountType: 'PERCENT',
            percentOff: 10,
            endsAt: new Date(Date.now() + DAY_MS).toISOString(),
          },
        ],
      ];
      const failures: string[] = [];
      const expectStatus = async (
        client: BearerClient,
        routes: readonly (readonly [HttpMethod, string, object?])[],
        status: number,
        label: string,
      ) => {
        for (const [method, path, body] of routes) {
          const req = client.call(method, path);
          const res = await (body === undefined ? req : req.send(body));
          if (res.status !== status) {
            failures.push(`${label} ${method.toUpperCase()} ${path} -> ${res.status}`);
          } else expectProblem(res, status);
        }
      };
      await expectStatus(studentA.http, adminRoutes, 403, 'student');
      // The student's own token through the admin BFF: not a session there.
      await expectStatus(
        e2e.as('admin', studentA.token.accessToken),
        adminRoutes.slice(0, 2),
        401,
        'student via admin app',
      );
      const meRoutes: (readonly [HttpMethod, string, object?])[] = [
        ['post', `${V1}/me/checkout`, { expectedTotal: '19.99' }],
        ['get', `${V1}/me/orders`],
        ['get', `${V1}/me/orders/${paidOfA.orderId}`],
        [
          'post',
          `${V1}/me/orders/${paidOfA.orderId}/refunds`,
          { orderLineId: lineOfA, reasonCode: 'QUALITY' },
        ],
        ['put', `${V1}/me/cart/items/${a1.courseId}`],
      ];
      await expectStatus(
        e2e.as('instructor', instructorAToken.accessToken),
        meRoutes,
        403,
        'instructor app',
      );
      await expectStatus(
        e2e.as('instructor', studentA.token.accessToken),
        meRoutes.slice(1, 3),
        401,
        'student via instructor app',
      );
      expect(failures).toEqual([]);
      expect(await orderStatus(paidOfA.orderId)).toBe('PAID');
    });
  });

  /* ------------------------------------------------------------------ §9 concurrency */

  describe('§9 concurrency over HTTP', () => {
    it(
      'N=20 parallel checkouts against max_redemptions=1: exactly one reservation, 19 x 409 price_changed',
      async (ctx) => {
        skip(ctx);
        const c = await course('59.99');
        const code = testCouponCode('BURST');
        const couponId = await insertTestCoupon(e2e.pg.db, {
          createdBy: fixtures().instructorA.userId,
          courseId: c.courseId,
          code,
          percentOff: 50,
          maxRedemptions: 1,
        });
        const buyers: Student[] = [];
        for (let i = 0; i < 20; i += 5) {
          buyers.push(
            ...(await Promise.all([0, 1, 2, 3, 4].map((j) => student(`burst-${i + j}`)))),
          );
        }
        for (const b of buyers) {
          await b.http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
          await b.http.put(`${V1}/me/cart/coupon`).send({ code }).expect(200);
        }
        for (const b of buyers.slice(0, 2)) expect(await cartTotal(b.http)).toBe('29.99');
        const results = await Promise.all(buyers.map((b) => postCheckout(b.http, '29.99')));
        expect(results.map((r) => r.status).sort()).toEqual([
          201,
          ...Array.from({ length: 19 }, () => 409),
        ]);
        for (const r of results.filter((x) => x.status === 409)) {
          expectProblem(r, 409, ErrorCode.PriceChanged);
        }
        const reserved = await e2e.pg.db
          .selectFrom('commerce.couponRedemptions')
          .select(['status', 'orderId'])
          .where('couponId', '=', couponId)
          .execute();
        const winner = CheckoutResponseSchema.parse(results.find((r) => r.status === 201)?.body);
        expect(reserved).toEqual([{ status: 'RESERVED', orderId: winner.orderId }]);
      },
      SLOW_MS,
    );

    it('the same Idempotency-Key twice in parallel: one order, one session; two keys in parallel: one 201 and one 409 checkout_in_progress', async (ctx) => {
      skip(ctx);
      const c = await course('19.99');
      const same = await student('same-key');
      await same.http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
      const key = randomUUID();
      const [x, y] = await Promise.all([
        postCheckout(same.http, '19.99', key),
        postCheckout(same.http, '19.99', key),
      ]);
      expect([x.status, y.status]).toEqual([201, 201]);
      expect(x.body).toEqual(y.body);
      const placed = CheckoutResponseSchema.parse(x.body);
      const orders = await e2e.pg.db
        .selectFrom('commerce.orders')
        .select('id')
        .where('userId', '=', same.user.userId)
        .execute();
      expect(orders).toEqual([{ id: placed.orderId }]);
      expect(await emulatorSessionsOf(placed.orderId)).toHaveLength(1);

      const two = await student('two-keys');
      await two.http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
      const both = await Promise.all([
        postCheckout(two.http, '19.99'),
        postCheckout(two.http, '19.99'),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      const won = CheckoutResponseSchema.parse(both.find((r) => r.status === 201)?.body);
      const busy = CheckoutInProgressProblemSchema.parse(
        expectProblem(
          both.find((r) => r.status === 409) as request.Response,
          409,
          ErrorCode.CheckoutInProgress,
        ),
      );
      expect(busy.orderId).toBe(won.orderId);
      expect(
        await e2e.pg.db
          .selectFrom('commerce.orders')
          .select('id')
          .where('userId', '=', two.user.userId)
          .execute(),
      ).toHaveLength(1);
    });

    it('concurrent duplicate webhook deliveries (same id and bytes, and new ids for the same effect): one PAID, one OrderPaid, one grant; expired after completed is a no-op', async (ctx) => {
      skip(ctx);
      const buyer = await student('dup-webhooks');
      const c = await course('24.99');
      const placed = await placeOrder(buyer.http, [c.courseId]);
      const fixture = {
        sessionId: placed.sessionId,
        orderId: placed.orderId,
        amountTotalMinor: await orderTotalMinor(placed.orderId),
        paymentIntentId: fakePaymentIntent(),
      };
      const first = checkoutSessionCompletedEvent(fixture);
      const others = [1, 2, 3, 4].map(() => checkoutSessionCompletedEvent(fixture));
      const deliveries = [
        ...Array.from({ length: 8 }, () => deliver(first)),
        ...others.map((e) => deliver(e)),
      ];
      const responses = await Promise.all(deliveries);
      expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 12 }, () => 200));
      expect(responses.every((r) => (r.body as { received: boolean }).received)).toBe(true);

      expect(await orderStatus(placed.orderId)).toBe('PAID');
      const claims = await claimsOf(placed.orderId);
      expect(claims.map((cl) => cl.eventId).sort()).toEqual(
        [first.id, ...others.map((e) => e.id)].sort(),
      );
      expect(claims.filter((cl) => cl.outcome === 'APPLIED')).toHaveLength(1);
      expect(claims.filter((cl) => cl.outcome === 'DUPLICATE_EFFECT')).toHaveLength(4);
      expect(await outboxCount(placed.orderId, 'OrderPaid.v1')).toBe(1);
      const paidTransitions = await e2e.pg.db
        .selectFrom('commerce.orderTransitions')
        .select('toStatus')
        .where('orderId', '=', placed.orderId)
        .where('toStatus', '=', 'PAID')
        .execute();
      expect(paidTransitions).toHaveLength(1);
      const grants = await e2e.pg.db
        .selectFrom('enrollment.enrollments')
        .select(['status', 'source'])
        .where('userId', '=', buyer.user.userId)
        .execute();
      expect(grants).toEqual([{ status: 'ACTIVE', source: 'ORDER' }]);

      // checkout.session.expired after completed: acknowledged, recorded, no effect.
      const expired = checkoutSessionExpiredEvent({
        sessionId: placed.sessionId,
        orderId: placed.orderId,
      });
      await deliver(expired).expect(200);
      expect(await orderStatus(placed.orderId)).toBe('PAID');
      expect((await claimsOf(placed.orderId)).find((cl) => cl.eventId === expired.id)).toEqual({
        eventId: expired.id,
        outcome: 'IGNORED',
      });
      expect(await outboxCount(placed.orderId, 'OrderExpired.v1')).toBe(0);
    });

    it('late completed after cancel: PAID and enrolled (no refund); after a re-purchase: PAID plus a SYSTEM duplicate-purchase refund, access kept', async (ctx) => {
      skip(ctx);
      // (i) nothing bought in between: the late payment is honoured.
      const lone = await student('late-lone');
      const c = await course('19.99');
      const first = await placeOrder(lone.http, [c.courseId]);
      await lone.http.post(`${V1}/me/orders/${first.orderId}/cancel`).expect(200);
      expect(await orderStatus(first.orderId)).toBe('CANCELED');
      await settle(); // the emulator's own checkout.session.expired: a no-op now
      await deliver(
        checkoutSessionCompletedEvent({
          sessionId: first.sessionId,
          orderId: first.orderId,
          amountTotalMinor: await orderTotalMinor(first.orderId),
          paymentIntentId: fakePaymentIntent(),
        }),
      ).expect(200);
      const detail = OrderDetailSchema.parse(
        (await lone.http.get(`${V1}/me/orders/${first.orderId}`).expect(200)).body,
      );
      expect(detail).toMatchObject({ status: 'PAID', payment: { status: 'SUCCEEDED' } });
      expect(
        await e2e.pg.db
          .selectFrom('enrollment.enrollments')
          .select('status')
          .where('userId', '=', lone.user.userId)
          .where('courseId', '=', c.courseId)
          .execute(),
      ).toEqual([{ status: 'ACTIVE' }]);
      expect(
        await e2e.pg.db
          .selectFrom('commerce.refunds')
          .select('id')
          .where('orderId', '=', first.orderId)
          .execute(),
      ).toEqual([]);

      // (ii) canceled, bought again and paid, then the first session's late completion: the
      // second payment is a duplicate (D15) -> SYSTEM refund; the enrollment stays ACTIVE.
      const again = await student('late-again');
      const d = await course('24.99');
      const old = await placeOrder(again.http, [d.courseId]);
      await again.http.post(`${V1}/me/orders/${old.orderId}/cancel`).expect(200);
      await settle();
      const second = await buy(again.http, [d.courseId]);
      // The kick is off so the SYSTEM refund stays APPROVED: its payment intent is synthetic
      // (the emulator expired that session), so the provider could not refund it anyway.
      await withoutKick(async () => {
        await deliver(
          checkoutSessionCompletedEvent({
            sessionId: old.sessionId,
            orderId: old.orderId,
            amountTotalMinor: await orderTotalMinor(old.orderId),
            paymentIntentId: fakePaymentIntent(),
          }),
        ).expect(200);
      });
      expect(await orderStatus(old.orderId)).toBe('PAID');
      expect(await orderStatus(second.orderId)).toBe('PAID');
      const refunds = await e2e.pg.db
        .selectFrom('commerce.refunds')
        .select(['status', 'initiatedBy', 'reasonCode', 'orderLineId'])
        .where('orderId', '=', old.orderId)
        .execute();
      expect(refunds).toEqual([
        {
          status: 'APPROVED',
          initiatedBy: 'SYSTEM',
          reasonCode: 'DUPLICATE_PURCHASE',
          orderLineId: (await linesOf(old.orderId))[0]?.id,
        },
      ]);
      const enrollment = await e2e.pg.db
        .selectFrom('enrollment.enrollments')
        .select(['status', 'orderLineId'])
        .where('userId', '=', again.user.userId)
        .where('courseId', '=', d.courseId)
        .executeTakeFirstOrThrow();
      expect(enrollment).toEqual({ status: 'ACTIVE', orderLineId: second.line(d.courseId) });
    });

    it('a refund request racing an admin refund of the same line: one 201, one 409 refund_already_requested, one live refund', async (ctx) => {
      skip(ctx);
      const buyer = await student('refund-race');
      const c = await course('19.99');
      const paid = await buy(buyer.http, [c.courseId]);
      const line = paid.line(c.courseId);
      const [byStudent, byAdmin] = await Promise.all([
        postRefund(buyer.http, paid.orderId, line),
        adminHttp()
          .post(`${V1}/admin/orders/${paid.orderId}/refunds`)
          .send({ orderLineIds: [line], reason: REASON }),
      ]);
      expect([byStudent.status, byAdmin.status].sort()).toEqual([201, 409]);
      const loser = byStudent.status === 409 ? byStudent : byAdmin;
      expectProblem(loser, 409, ErrorCode.RefundAlreadyRequested);
      await settle();
      const live = await e2e.pg.db
        .selectFrom('commerce.refunds')
        .select(['status', 'orderLineId'])
        .where('orderId', '=', paid.orderId)
        .execute();
      expect(live).toEqual([{ status: 'SUCCEEDED', orderLineId: line }]);
      expect(await orderStatus(paid.orderId)).toBe('REFUNDED');
    });
  });

  /* ------------------------------------------------------------------ refund lifecycle */

  it('refund lifecycle: APPROVED -> SUBMITTED -> FAILED -> (retry) APPROVED -> SUCCEEDED; every other admin action is 409 in each state', async (ctx) => {
    skip(ctx);
    const buyer = await student('lifecycle');
    const c = await course('29.99');
    const paid = await buy(buyer.http, [c.courseId]);
    await control('/refunds/next', { outcome: 'pending' });
    const refund = RefundSchema.parse(
      (await postRefund(buyer.http, paid.orderId, paid.line(c.courseId)).expect(201)).body,
    );
    expect(refund.status).toBe('APPROVED');
    await settle();
    const submitted = await refundRow(refund.id);
    expect(submitted.status).toBe('SUBMITTED');

    const act = (action: 'approve' | 'reject' | 'retry') =>
      adminHttp()
        .post(`${V1}/admin/refunds/${refund.id}/${action}`)
        .send(action === 'reject' ? { reason: REASON } : {});
    const refused = async (actions: readonly ('approve' | 'reject' | 'retry')[]) => {
      for (const action of actions) {
        expectProblem(await act(action), 409, ErrorCode.InvalidStateTransition);
      }
    };
    await refused(['approve', 'reject', 'retry']); // SUBMITTED

    await control(`/refunds/${submitted.providerRefundId ?? ''}/settle`, {
      outcome: 'failed',
      failureReason: 'insufficient_funds',
    });
    await settle();
    expect(await refundRow(refund.id)).toMatchObject({ status: 'FAILED', attempt: 1 });
    expect(await outboxCount(paid.orderId, 'RefundFailed.v1')).toBe(1);
    await refused(['approve', 'reject']); // FAILED

    const retried = RefundDecisionResponseSchema.parse((await act('retry').expect(200)).body);
    expect(retried).toMatchObject({ status: 'APPROVED', attempt: 2 });
    await settle();
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUCCEEDED', attempt: 2 });
    await refused(['approve', 'reject', 'retry']); // SUCCEEDED

    const log = await e2e.pg.db
      .selectFrom('commerce.refundTransitions')
      .select('toStatus')
      .where('refundId', '=', refund.id)
      .orderBy('seq')
      .execute();
    const statuses = log.map((t) => t.toStatus);
    expect(statuses.slice(0, 4)).toEqual(['APPROVED', 'SUBMITTED', 'FAILED', 'APPROVED']);
    expect(statuses.at(-1)).toBe('SUCCEEDED');
    expect(await orderStatus(paid.orderId)).toBe('REFUNDED');
    expect(await outboxCount(paid.orderId, 'RefundSucceeded.v1')).toBe(1);
    // The buyer cannot open a second refund for the refunded line.
    expectProblem(
      await postRefund(buyer.http, paid.orderId, paid.line(c.courseId)),
      409,
      ErrorCode.RefundAlreadyRequested,
    );
  });

  /* ------------------------------------------------------------------ §8 error codes */

  describe('§8 error codes not sent over HTTP elsewhere', () => {
    it('cart: already_enrolled, course_not_for_sale (unpriced, archived), cart_full, 429; DELETE of an absent item is 200', async (ctx) => {
      skip(ctx);
      const buyer = await student('cart-errors');
      const owned = await course('19.99');
      await insertTestEnrollment(e2e.pg.db, buyer.user.userId, owned.courseId);
      const put = (id: string) => buyer.http.put(`${V1}/me/cart/items/${id}`);
      expectProblem(await put(owned.courseId), 409, ErrorCode.AlreadyEnrolled);
      expectProblem(await put((await course(null)).courseId), 409, ErrorCode.CourseNotForSale);
      const archived = await course('19.99');
      await setTestCourseStatus(e2e.pg.db, archived.courseId, 'ARCHIVED');
      expectProblem(await put(archived.courseId), 409, ErrorCode.CourseNotForSale);
      await buyer.http.delete(`${V1}/me/cart/items/${archived.courseId}`).expect(200);

      const max = get(CommerceSettings).cartMaxItems;
      for (let i = 0; i < max; i += 1) {
        await put((await course('19.99')).courseId).expect(200);
      }
      expectProblem(await put((await course('19.99')).courseId), 422, ErrorCode.CartFull);
      expect(CartQuoteSchema.parse((await buyer.http.get(`${V1}/me/cart`)).body).itemCount).toBe(
        max,
      );

      await fillBucket(commerceRateLimitKeys.cartWrite(buyer.user.userId), 120);
      const limited = await put(owned.courseId);
      expectProblem(limited, 429, ErrorCode.RateLimited);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('coupons: coupon_expired, coupon_not_started, coupon_exhausted, coupon_already_used (code valid for the cart), then 429', async (ctx) => {
      skip(ctx);
      const buyer = await student('coupon-errors');
      const someoneElse = await student('coupon-other');
      const c = await course('49.99');
      await buyer.http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
      const owner = fixtures().instructorA.userId;
      const coupon = async (options: {
        startsAt?: Date;
        endsAt?: Date;
        maxRedemptions?: number;
      }): Promise<{ id: string; code: string }> => {
        const code = testCouponCode('ERR');
        const id = await insertTestCoupon(e2e.pg.db, {
          createdBy: owner,
          courseId: c.courseId,
          code,
          ...options,
        });
        return { id, code };
      };
      const apply = (code: string) => buyer.http.put(`${V1}/me/cart/coupon`).send({ code });

      const expired = await coupon({
        startsAt: new Date(Date.now() - 10 * DAY_MS),
        endsAt: new Date(Date.now() - DAY_MS),
      });
      expectProblem(await apply(expired.code), 422, ErrorCode.CouponExpired);
      const later = await coupon({
        startsAt: new Date(Date.now() + DAY_MS),
        endsAt: new Date(Date.now() + 5 * DAY_MS),
      });
      expectProblem(await apply(later.code), 422, ErrorCode.CouponNotStarted);
      const exhausted = await coupon({ maxRedemptions: 1 });
      await insertTestRedemption(e2e.pg.db, {
        couponId: exhausted.id,
        userId: someoneElse.user.userId,
        status: 'CONSUMED',
      });
      expectProblem(await apply(exhausted.code), 422, ErrorCode.CouponExhausted);
      const used = await coupon({});
      await insertTestRedemption(e2e.pg.db, {
        couponId: used.id,
        userId: buyer.user.userId,
        status: 'CONSUMED',
      });
      expectProblem(await apply(used.code), 422, ErrorCode.CouponAlreadyUsed);

      await fillBucket(commerceRateLimitKeys.couponApplyUser(buyer.user.userId), 20);
      expectProblem(await apply((await coupon({})).code), 429, ErrorCode.RateLimited);
    });

    it('purchase states: enrolled / inCart / isOwner per id; 400 for too many or malformed ids', async (ctx) => {
      skip(ctx);
      const buyer = await student('states');
      const inCart = await course('19.99');
      const owned = await course('24.99');
      await buyer.http.put(`${V1}/me/cart/items/${inCart.courseId}`).expect(200);
      await insertTestEnrollment(e2e.pg.db, buyer.user.userId, owned.courseId);
      const states = PurchaseStatesResponseSchema.parse(
        (
          await buyer.http
            .get(`${V1}/me/purchase-states?courseIds=${inCart.courseId},${owned.courseId}`)
            .expect(200)
        ).body,
      );
      expect(states.items).toEqual([
        expect.objectContaining({
          courseId: inCart.courseId,
          enrolled: false,
          inCart: true,
          isOwner: false,
        }),
        expect.objectContaining({
          courseId: owned.courseId,
          enrolled: true,
          inCart: false,
          isOwner: false,
        }),
      ]);
      const tooMany = Array.from({ length: 49 }, () => randomUUID()).join(',');
      expectProblem(
        await buyer.http.get(`${V1}/me/purchase-states?courseIds=${tooMany}`),
        400,
        ErrorCode.ValidationFailed,
      );
      expectProblem(
        await buyer.http.get(`${V1}/me/purchase-states?courseIds=nope`),
        400,
        ErrorCode.ValidationFailed,
      );
    });

    it('checkout: amount_below_minimum (0 < total < 0.50), then 429 after 10 checkouts in 10 min', async (ctx) => {
      skip(ctx);
      const buyer = await student('below-minimum');
      const c = await course('19.99');
      const code = testCouponCode('TINY');
      await insertTestCoupon(e2e.pg.db, {
        createdBy: fixtures().instructorA.userId,
        courseId: c.courseId,
        code,
        amountOff: '19.60',
      });
      await buyer.http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
      await buyer.http.put(`${V1}/me/cart/coupon`).send({ code }).expect(200);
      expect(await cartTotal(buyer.http)).toBe('0.39');
      expectProblem(await postCheckout(buyer.http, '0.39'), 422, ErrorCode.AmountBelowMinimum);
      expect(
        await e2e.pg.db
          .selectFrom('commerce.orders')
          .select('id')
          .where('userId', '=', buyer.user.userId)
          .execute(),
      ).toEqual([]);
      await fillBucket(commerceRateLimitKeys.checkout(buyer.user.userId), 10);
      expectProblem(await postCheckout(buyer.http, '0.39'), 429, ErrorCode.RateLimited);
    });

    it('free enroll: course_not_free for a paid course, cannot_purchase_own_course for the owner', async (ctx) => {
      skip(ctx);
      const buyer = await student('free-errors');
      const paid = await course('19.99');
      const free = await course('0.00');
      const enroll = (http: BearerClient, courseId: string) =>
        http.post(`${V1}/me/free-enrollments`).send({ courseId });
      expectProblem(await enroll(buyer.http, paid.courseId), 409, ErrorCode.CourseNotFree);
      const ownerAsStudent = e2e.as(
        'student',
        (await e2e.login('student', fixtures().instructorA.email)).accessToken,
      );
      expectProblem(
        await enroll(ownerAsStudent, free.courseId),
        409,
        ErrorCode.CannotPurchaseOwnCourse,
      );
      expect((await enroll(buyer.http, free.courseId).expect(201)).body).toMatchObject({
        source: 'FREE',
      });
    });

    it('refunds: refund_not_applicable for a 0.00 line, 404 for an unknown line of an own order, 429 after 5 requests in 24 h', async (ctx) => {
      skip(ctx);
      const buyer = await student('refund-errors');
      const c = await course('49.99');
      const code = testCouponCode('FULL');
      await insertTestCoupon(e2e.pg.db, {
        createdBy: fixtures().instructorA.userId,
        courseId: c.courseId,
        code,
        percentOff: 100,
      });
      await buyer.http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
      await buyer.http.put(`${V1}/me/cart/coupon`).send({ code }).expect(200);
      const zero = CheckoutResponseSchema.parse(
        (await postCheckout(buyer.http, '0.00').expect(201)).body,
      );
      expect(zero).toMatchObject({ status: 'PAID', checkoutUrl: null });
      const line = (await linesOf(zero.orderId))[0]?.id ?? '';
      expectProblem(
        await postRefund(buyer.http, zero.orderId, line),
        422,
        ErrorCode.RefundNotApplicable,
      );
      expectProblem(await postRefund(buyer.http, zero.orderId, randomUUID()), 404);
      await fillBucket(commerceRateLimitKeys.refundRequest(buyer.user.userId), 5);
      expectProblem(await postRefund(buyer.http, zero.orderId, line), 429, ErrorCode.RateLimited);
    });

    it('instructor: price changes 429 (10/day/course), course coupons course_is_free (422) and 429 (50/day); deactivating an unknown coupon is 404', async (ctx) => {
      skip(ctx);
      const { instructorA: owner } = fixtures();
      const priced = await course('19.99');
      await fillBucket(commerceRateLimitKeys.priceChange(priced.courseId), 10);
      expectProblem(
        await instructorA()
          .put(`${V1}/courses/${priced.courseId}/pricing`)
          .send({ amount: '24.99' }),
        429,
        ErrorCode.RateLimited,
      );
      const body = () => ({
        code: testCouponCode('P4C'),
        discountType: 'PERCENT',
        percentOff: 20,
        endsAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      });
      const free = await course('0.00');
      expectProblem(
        await instructorA().post(`${V1}/courses/${free.courseId}/coupons`).send(body()),
        422,
        ErrorCode.CourseIsFree,
      );
      expectProblem(
        await instructorA().post(
          `${V1}/courses/${priced.courseId}/coupons/${randomUUID()}/deactivate`,
        ),
        404,
      );
      const key = commerceRateLimitKeys.couponCreate(owner.userId);
      await fillBucket(key, 50);
      try {
        expectProblem(
          await instructorA().post(`${V1}/courses/${priced.courseId}/coupons`).send(body()),
          429,
          ErrorCode.RateLimited,
        );
      } finally {
        await e2e.redis.redis.del(key);
      }
    });

    it('admin: unknown order / refund ids are 404 on every action; a taken platform code is 409', async (ctx) => {
      skip(ctx);
      const order = randomUUID();
      const refund = randomUUID();
      expectProblem(
        await adminHttp().get(`${V1}/admin/orders/${order}`),
        404,
        ErrorCode.OrderNotFound,
      );
      expectProblem(
        await adminHttp()
          .post(`${V1}/admin/orders/${order}/refunds`)
          .send({ orderLineIds: [randomUUID()], reason: REASON }),
        404,
      );
      expectProblem(
        await adminHttp()
          .post(`${V1}/admin/orders/${order}/accept-payment`)
          .send({ reason: REASON }),
        404,
      );
      for (const action of ['reject', 'retry'] as const) {
        expectProblem(
          await adminHttp()
            .post(`${V1}/admin/refunds/${refund}/${action}`)
            .send(action === 'reject' ? { reason: REASON } : {}),
          404,
          ErrorCode.RefundNotFound,
        );
      }
      // A line of ANOTHER order inside this order: 404 too (lines resolve within the order).
      const { paidOfA, paidOfB, b1 } = fixtures();
      expectProblem(
        await adminHttp()
          .post(`${V1}/admin/orders/${paidOfA.orderId}/refunds`)
          .send({ orderLineIds: [paidOfB.line(b1.courseId)], reason: REASON }),
        404,
      );
      const code = testCouponCode('P4P');
      const platform = {
        code,
        discountType: 'PERCENT',
        percentOff: 10,
        endsAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      };
      await adminHttp().post(`${V1}/admin/coupons`).send(platform).expect(201);
      expectProblem(
        await adminHttp().post(`${V1}/admin/coupons`).send(platform),
        409,
        ErrorCode.CouponCodeTaken,
      );
    });

    it('my orders: keyset pages, newest first', async (ctx) => {
      skip(ctx);
      const { studentA, paidOfA, pendingOfA } = fixtures();
      const page1 = OrderSummaryPageSchema.parse(
        (await studentA.http.get(`${V1}/me/orders?limit=1`).expect(200)).body,
      );
      expect(page1.items.map((i) => i.id)).toEqual([pendingOfA.orderId]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = OrderSummaryPageSchema.parse(
        (
          await studentA.http
            .get(`${V1}/me/orders?limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`)
            .expect(200)
        ).body,
      );
      expect(page2).toEqual({
        items: [expect.objectContaining({ id: paidOfA.orderId })],
        nextCursor: null,
      });
      const bad = await studentA.http.get(`${V1}/me/orders?cursor=Zm9vYmFy`);
      expect([400, 422]).toContain(bad.status);
      expectProblem(bad, bad.status);
    });
  });

  /* ------------------------------------------------------------------ webhook security */

  it('webhook security: future timestamp, no v1, garbage header -> 400; a rolled secret (one valid v1) -> 200; livemode, unpaid and orphan events are acknowledged without effect', async (ctx) => {
    skip(ctx);
    const buyer = await student('webhook-sec');
    const c = await course('19.99');
    const placed = await placeOrder(buyer.http, [c.courseId]);
    const fixture = {
      sessionId: placed.sessionId,
      orderId: placed.orderId,
      amountTotalMinor: await orderTotalMinor(placed.orderId),
      paymentIntentId: fakePaymentIntent(),
    };
    const event = checkoutSessionCompletedEvent(fixture, { livemode: true });
    eventIds.push(event.id);
    const body = Buffer.from(JSON.stringify(event), 'utf8');
    const send = (signature: string) =>
      e2e
        .http()
        .post(WEBHOOK)
        .set({ 'content-type': 'application/json', 'stripe-signature': signature })
        .send(body.toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', env.webhookSecret).update(`${now}.`).update(body).digest('hex');
    for (const bad of [
      signTestWebhook(body, env.webhookSecret, now + 600),
      `t=${now}`,
      `v1=${v1}`,
      'garbage',
      `t=${now},t=${now},v1=${v1}`,
    ]) {
      const res = expectProblem(await send(bad), 400, ErrorCode.WebhookSignatureInvalid);
      expect(res.detail).toBeUndefined();
    }
    expect(await claimsOf(placed.orderId)).toEqual([]);

    // Secret rolling: an old signature first, then the valid one: accepted. livemode -> IGNORED.
    await send(
      signTestWebhook(body, env.webhookSecret, now, { extraSignatures: ['0'.repeat(64)] }),
    ).expect(200);
    const livemode = await e2e.pg.db
      .selectFrom('commerce.providerEvents')
      .select(['outcome', 'orderId'])
      .where('eventId', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(livemode.outcome).toBe('IGNORED');
    expect(await orderStatus(placed.orderId)).toBe('PENDING_PAYMENT');

    // payment_status unpaid: IGNORED, still pending.
    const unpaid = checkoutSessionCompletedEvent({ ...fixture, paymentStatus: 'unpaid' });
    await deliver(unpaid).expect(200);
    expect(await orderStatus(placed.orderId)).toBe('PENDING_PAYMENT');
    expect((await claimsOf(placed.orderId)).find((cl) => cl.eventId === unpaid.id)?.outcome).toBe(
      'IGNORED',
    );

    // An order nobody knows: ORPHAN, still a 200 (Stripe must not retry forever).
    const orphan = checkoutSessionCompletedEvent({
      sessionId: `cs_test_${randomUUID().replace(/-/g, '')}`,
      orderId: randomUUID(),
      amountTotalMinor: 1999,
      paymentIntentId: fakePaymentIntent(),
    });
    await deliver(orphan).expect(200);
    const orphanClaim = await e2e.pg.db
      .selectFrom('commerce.providerEvents')
      .select(['outcome', 'orderId'])
      .where('eventId', '=', orphan.id)
      .executeTakeFirstOrThrow();
    expect(orphanClaim).toEqual({ outcome: 'ORPHAN', orderId: null });
  });

  /* ------------------------------------------------------------------ reconcile (b) */

  it('reconcile (b): the completed webhook is lost (500s until Stripe gives up) -> reconcile retrieves the session -> PAID by RECONCILER; a later redelivery is DUPLICATE_EFFECT', async (ctx) => {
    skip(ctx);
    const buyer = await student('lost-webhook');
    const c = await course('24.99');
    const placed = await placeOrder(buyer.http, [c.courseId]);
    const command = get(HandleProviderEventCommand);
    const original = command.execute.bind(command);
    const outage = vi.spyOn(command, 'execute').mockImplementation(async (event, sha, source) => {
      if (source === 'WEBHOOK') throw new Error('simulated outage');
      return original(event, sha, source);
    });
    const failedEventId = await (async (): Promise<string> => {
      try {
        await control(`/checkout/sessions/${placed.sessionId}/complete`);
        expect((await control('/webhooks/drain?timeoutMs=20000')).idle).toBe(true);
        const res = await fetch(
          `${env.emulatorUrl}/_emulator/events?type=checkout.session.completed&status=failed`,
        );
        const failed = ((await res.json()) as { data: { id: string; objectId: string | null }[] })
          .data;
        return failed.find((e) => e.objectId === placed.sessionId)?.id ?? '';
      } finally {
        outage.mockRestore();
      }
    })();
    expect(failedEventId).not.toBe('');
    eventIds.push(failedEventId);
    expect(await orderStatus(placed.orderId)).toBe('PENDING_PAYMENT');
    expect(await claimsOf(placed.orderId)).toEqual([]); // 500 = rolled back, nothing claimed

    await agePayment(placed.orderId, 60);
    expect(await reconcileOnly([buyer.user.userId])).toEqual({
      locked: true,
      abandoned: 0,
      completed: 1,
      expired: 0,
      skipped: 0,
    });
    expect(await orderStatus(placed.orderId)).toBe('PAID');
    const last = await e2e.pg.db
      .selectFrom('commerce.orderTransitions')
      .select(['toStatus', 'cause'])
      .where('orderId', '=', placed.orderId)
      .orderBy('occurredAt', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(last).toEqual({ toStatus: 'PAID', cause: 'RECONCILER' });
    expect(
      await e2e.pg.db
        .selectFrom('enrollment.enrollments')
        .select('status')
        .where('userId', '=', buyer.user.userId)
        .execute(),
    ).toEqual([{ status: 'ACTIVE' }]);

    const again = await control(`/events/${failedEventId}/redeliver`);
    expect(again.attempt).toMatchObject({ statusCode: 200 });
    expect(await claimsOf(placed.orderId)).toEqual([
      { eventId: `reconcile:${placed.sessionId}:COMPLETED`, outcome: 'APPLIED' },
      { eventId: failedEventId, outcome: 'DUPLICATE_EFFECT' },
    ]);
    expect(await outboxCount(placed.orderId, 'OrderPaid.v1')).toBe(1);
  });

  /* ------------------------------------------------------------------ ledger (D13) */

  it(
    'ledger: the API outbox OrderPaid / RefundSucceeded events of this file, posted as the worker does, reconcile with commerce (no differences; totals equal; replays post nothing)',
    async (ctx) => {
      skip(ctx);
      // One more shape for the ledger: a PAYMENT_REVIEW order (charged 1.00 more than its
      // total) accepted by an admin: paid_at is set by the accept, OrderPaid carries the lines.
      const reviewed = await student('ledger-review');
      const c = await course('19.99');
      const placed = await placeOrder(reviewed.http, [c.courseId]);
      await deliver(
        checkoutSessionCompletedEvent({
          sessionId: placed.sessionId,
          orderId: placed.orderId,
          amountTotalMinor: (await orderTotalMinor(placed.orderId)) + 100,
          paymentIntentId: fakePaymentIntent(),
        }),
      ).expect(200);
      expect(await orderStatus(placed.orderId)).toBe('PAYMENT_REVIEW');
      await adminHttp()
        .post(`${V1}/admin/orders/${placed.orderId}/accept-payment`)
        .send({ reason: REASON })
        .expect(200);
      expect(await orderStatus(placed.orderId)).toBe('PAID');
      await settle();
      const db = e2e.pg.db;
      const userIds = allUsers().map((u) => u.userId);
      const orders = await db
        .selectFrom('commerce.orders')
        .select(['id', 'paidAt'])
        .where('userId', 'in', userIds)
        .execute();
      const orderIds = orders.map((o) => o.id);
      const lineIds = (
        await db
          .selectFrom('commerce.orderLines')
          .select('id')
          .where('orderId', 'in', orderIds)
          .execute()
      ).map((l) => l.id);
      const scope = { orderLineIds: lineIds };
      const events = await db
        .selectFrom('outbox.events')
        .select(['id', 'type', 'payload'])
        .where('aggregateId', 'in', orderIds)
        .where('type', 'in', ['OrderPaid.v1', 'RefundSucceeded.v1'])
        .orderBy('createdAt')
        .orderBy('id')
        .execute();
      const sales = events.filter((e) => e.type === 'OrderPaid.v1');
      const refunds = events.filter((e) => e.type === 'RefundSucceeded.v1');
      // This file paid orders (with a coupon, a zero total, a late payment, a reconciled one)
      // and refunded some of them.
      expect(sales.length).toBeGreaterThanOrEqual(9);
      expect(refunds.length).toBeGreaterThanOrEqual(2);

      const preexisting = await db
        .selectFrom('payouts.journalEntries')
        .select('id')
        .where('orderLineId', 'in', lineIds)
        .execute();
      if (preexisting.length === 0) {
        // Not vacuous: before posting, every paid line with a final > 0 is reported missing.
        const missing = await reconcileLedger(db, scope);
        expect(missing.length).toBeGreaterThan(0);
        expect(missing.every((d) => d.problem === 'missing or wrong')).toBe(true);
      }

      // The payouts.ledger-writer handlers, step by step (apps/worker/src/payouts/handlers):
      // one transaction per event, SALE per line of OrderPaid, the mirror REFUND for
      // RefundSucceeded of an order that was ever PAID.
      const post = async () => {
        const outcomes: string[] = [];
        for (const event of sales) {
          const paid = OrderPaid.parsePayload(event.payload);
          await db.transaction().execute(async (trx) => {
            for (const line of paid.lines) {
              const result = await postSaleEntry(trx, {
                orderLineId: line.orderLineId,
                sourceEventId: event.id,
                occurredAt: new Date(paid.paidAt),
                currency: paid.currency,
                instructorId: line.instructorId,
                finalAmount: line.finalAmount,
                instructorShareAmount: line.instructorShareAmount,
                platformShareAmount: line.platformShareAmount,
              });
              outcomes.push(result.outcome);
            }
          });
        }
        for (const event of refunds) {
          const refunded = RefundSucceeded.parsePayload(event.payload);
          // LedgerJournal.orderWasPaid: a PAYMENT_REVIEW -> REFUNDED order has no SALE.
          const order = orders.find((o) => o.id === refunded.orderId);
          if (order === undefined || order.paidAt === null) continue;
          await db.transaction().execute(async (trx) => {
            const result = await postRefundEntry(trx, {
              orderLineId: refunded.orderLineId,
              refundId: refunded.refundId,
              sourceEventId: event.id,
              occurredAt: new Date(refunded.succeededAt),
            });
            outcomes.push(result.outcome);
          });
        }
        return outcomes;
      };
      const first = await post();
      expect(first).toContain('POSTED');
      expect(first).toContain('ZERO_AMOUNT'); // the 100% coupon order
      expect(await reconcileLedger(db, scope)).toEqual([]);
      const totals = await getLedgerTotals(db, scope);
      expect(totals.ledgerSales).toBe(totals.commerceSales);
      expect(totals.ledgerRefunds).toBe(totals.commerceRefunds);
      expect(Number(totals.commerceSales)).toBeGreaterThan(0);
      expect(Number(totals.commerceRefunds)).toBeGreaterThan(0);
      const succeeded = await db
        .selectFrom('commerce.refunds')
        .select((eb) => eb.fn.sum<string>('amount').as('total'))
        .where('orderId', 'in', orderIds)
        .where('status', '=', 'SUCCEEDED')
        .executeTakeFirstOrThrow();
      expect(Number(totals.commerceRefunds)).toBe(Number(succeeded.total));

      // Replays (a redelivered or re-emitted event) post nothing new.
      expect((await post()).filter((o) => o === 'POSTED')).toEqual([]);
      expect(await reconcileLedger(db, scope)).toEqual([]);
    },
    SLOW_MS,
  );

  /* ------------------------------------------------------------------ outage + reconcile (a) */

  // Last: it restarts the emulator (its in-memory state, sessions and idempotency keys, is gone).
  it(
    'provider outage: 503 payment_provider_unavailable, the order stays CREATING; the same key resumes it once the provider is back; a stale CREATING is abandoned by reconcile (a)',
    async (ctx) => {
      skip(ctx);
      const resumer = await student('outage-resume');
      const stale = await student('outage-stale');
      const canceler = await student('outage-cancel');
      const c = await course('19.99');
      for (const s of [resumer, stale, canceler]) {
        await s.http.put(`${V1}/me/cart/items/${c.courseId}`).expect(200);
      }
      await settle();
      await emulator?.close();
      emulator = undefined;
      const key = randomUUID();
      try {
        expectProblem(
          await postCheckout(resumer.http, '19.99', key),
          503,
          ErrorCode.PaymentProviderUnavailable,
        );
        for (const s of [stale, canceler]) {
          expectProblem(
            await postCheckout(s.http, '19.99'),
            503,
            ErrorCode.PaymentProviderUnavailable,
          );
        }
      } finally {
        await bootEmulator();
      }
      const creating = async (userId: string) =>
        e2e.pg.db
          .selectFrom('commerce.orders as o')
          .innerJoin('commerce.payments as p', 'p.orderId', 'o.id')
          .select(['o.id', 'o.status', 'p.status as paymentStatus', 'p.checkoutUrl'])
          .where('o.userId', '=', userId)
          .executeTakeFirstOrThrow();
      const before = await creating(resumer.user.userId);
      expect(before).toMatchObject({ paymentStatus: 'CREATING', checkoutUrl: null });
      const staleOrder = await creating(stale.user.userId);
      expect(staleOrder.paymentStatus).toBe('CREATING');

      // The same key resumes at the provider call: the same order, now with a session.
      const resumed = CheckoutResponseSchema.parse(
        (await postCheckout(resumer.http, '19.99', key).expect(201)).body,
      );
      expect(resumed).toMatchObject({ orderId: before.id, status: 'PENDING_PAYMENT' });
      expect((await emulatorSession(sessionIdOf(resumed.checkoutUrl))).status).toBe('open');
      expect(await creating(resumer.user.userId)).toMatchObject({ paymentStatus: 'OPEN' });

      // The other buyer never retried: after 15 min the reconciler replays the create with the
      // same key, expires that session and abandons the payment.
      await agePayment(staleOrder.id, 16);
      expect(await reconcileOnly([stale.user.userId])).toEqual({
        locked: true,
        abandoned: 1,
        completed: 0,
        expired: 0,
        skipped: 0,
      });
      expect(await creating(stale.user.userId)).toMatchObject({
        status: 'CANCELED',
        paymentStatus: 'ABANDONED',
      });
      // The outage meant the provider never held a session; the replay (same key, the stored
      // expires_at, now under Stripe's 30 min minimum) is refused, or creates one that is
      // expired at once. Either way nothing payable is left for the order.
      const replayed = await emulatorSessionsOf(staleOrder.id);
      expect(replayed.filter((s) => s.status === 'open')).toEqual([]);
      expect(await outboxCount(staleOrder.id, 'OrderCanceled.v1')).toBe(1);
      // The checkout slot is free again for that buyer.
      await postCheckout(stale.http, '19.99').expect(201);

      // The buyer cancels a CREATING order (§5 CancelPendingOrder): replay-then-expire, CANCELED.
      const toCancel = await creating(canceler.user.userId);
      expect(toCancel.paymentStatus).toBe('CREATING');
      const canceled = OrderDetailSchema.parse(
        (await canceler.http.post(`${V1}/me/orders/${toCancel.id}/cancel`).expect(200)).body,
      );
      expect(canceled).toMatchObject({ status: 'CANCELED', checkoutUrl: null });
      expect(await creating(canceler.user.userId)).toMatchObject({ paymentStatus: 'ABANDONED' });
      expect((await emulatorSessionsOf(toCancel.id)).filter((s) => s.status === 'open')).toEqual(
        [],
      );
      await postCheckout(canceler.http, '19.99').expect(201);
    },
    SLOW_MS,
  );
});

/** [path, method] of every route Express serves (Nest's `:param` written as `{param}`). */
function expressRoutes(app: unknown): Operation[] {
  interface Layer {
    route?: { path: unknown; methods: Record<string, boolean> };
  }
  const router = (app as { router?: { stack?: Layer[] } }).router;
  if (router?.stack === undefined) throw new Error('unexpected Express internals: no app.router');
  return router.stack.flatMap((layer): Operation[] => {
    const route = layer.route;
    if (route === undefined || typeof route.path !== 'string') return [];
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    return Object.keys(route.methods)
      .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
      .map((method): Operation => [path, method]);
  });
}
