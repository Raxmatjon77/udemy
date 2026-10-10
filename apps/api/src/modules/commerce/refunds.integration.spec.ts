// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from '../../testing/apply-it-app-env';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  COMMERCE_ORDER_EVENTS,
  ErrorCode,
  type EventDefinition,
  RefundSucceeded,
} from '@udemy/contracts';
import {
  findActiveEnrollmentsWithLiveRefund,
  findOrderEnrollmentsWithoutPaidLine,
  sql,
} from '@udemy/db';
import {
  PAYMENT_PROVIDER,
  PaymentInvalidRequestError,
  PaymentProviderUnavailableError,
  type ProviderEvent,
  parseProviderEvent,
} from '@udemy/payments';
import {
  chargeRefundedEvent,
  checkoutSessionCompletedEvent,
  InMemoryPaymentProvider,
  refundFailedEvent,
  refundUpdatedEvent,
} from '@udemy/payments/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS } from '../../setup-app';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { CommerceJobs } from './application/commerce-jobs';
import { CommerceSettings } from './application/commerce-settings';
import { RefundDispatchRepository } from './application/ports/refund.repository';
import { RefundDispatcher } from './application/refund-dispatcher.service';
import { AcceptPaymentCommand } from './application/use-cases/accept-payment.command';
import { AddToCartCommand } from './application/use-cases/add-to-cart.command';
import { AdminRefundOrderLinesCommand } from './application/use-cases/admin-refund-order-lines.command';
import { ApplyCouponCommand } from './application/use-cases/apply-coupon.command';
import { type CheckoutResult, CheckoutCommand } from './application/use-cases/checkout.command';
import { GetAdminOrderQuery } from './application/use-cases/get-admin-order.query';
import { GetCartQuery } from './application/use-cases/get-cart.query';
import { GetMyOrderQuery } from './application/use-cases/get-my-order.query';
import {
  type HandleProviderEventResult,
  HandleProviderEventCommand,
} from './application/use-cases/handle-provider-event.command';
import {
  GetSalesSummaryQuery,
  ListRecentSalesQuery,
} from './application/use-cases/instructor-sales.queries';
import { ListRefundQueueQuery } from './application/use-cases/list-refund-queue.query';
import { RequestRefundCommand } from './application/use-cases/request-refund.command';
import { ReviewRefundCommand } from './application/use-cases/review-refund.command';
import { SearchAdminOrdersQuery } from './application/use-cases/search-admin-orders.query';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  deleteProviderEvents,
  insertCommerceTestUser,
  insertTestCoupon,
  insertTestCourse,
  insertTestEnrollment,
  setTestPrice,
  type TestCourse,
  testCouponCode,
} from './testing/commerce-it';

/*
 * P4-T16 against the integration Postgres + Redis through the real AppModule (every trigger,
 * deferred guard and the outbox), with `InMemoryPaymentProvider` as the provider (real
 * idempotency semantics). `COMMERCE_JOBS_ENABLED=false` here, so nothing dispatches in the
 * background: each test dispatches exactly its own refunds (`dispatchRefunds({ refundIds })`),
 * and a shared dev database's other refunds are never touched.
 */
const CHECKOUT_BASE = 'http://127.0.0.1:9/pay/';
const DAY_MS = 86_400_000;

type Get = <T>(token: abstract new (...args: never[]) => T) => T;

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}

interface PaidLine {
  id: string;
  courseId: string;
  finalAmount: string;
  instructorShareAmount: string;
  platformShareAmount: string;
}

interface PaidOrder {
  orderId: string;
  paymentIntentId: string;
  lines: PaidLine[];
  line(courseId: string): PaidLine;
}

describe('commerce C (integration: refunds, dispatcher, refund webhooks, admin, sales)', () => {
  const pg = useIntegrationDatabase({ max: 8 });
  const itRedis = useIntegrationRedis();
  const userIds: string[] = [];
  const courseIds: string[] = [];
  const eventIds: string[] = [];
  const provider = new InMemoryPaymentProvider({ checkoutBaseUrl: CHECKOUT_BASE });
  let app: NestExpressApplication | undefined;
  let owner = '';
  let admin = '';

  const get: Get = (token) => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const available = (): boolean => pg.available && itRedis.available;
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  async function user(label: string): Promise<string> {
    const id = await insertCommerceTestUser(pg.db, label);
    userIds.push(id);
    await pg.db
      .updateTable('identity.users')
      .set({ emailVerifiedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .execute();
    return id;
  }

  async function course(price = '19.99', ownerId = owner): Promise<TestCourse> {
    const created = await insertTestCourse(pg.db, { ownerId });
    courseIds.push(created.courseId);
    await setTestPrice(pg.db, created.courseId, price, ownerId);
    return created;
  }

  const total = async (userId: string): Promise<string> =>
    (await get(GetCartQuery).execute(userId)).totals.totalAmount;
  const sessionIdOf = (result: CheckoutResult): string => {
    if (result.checkoutUrl === null) throw new Error('no checkout url');
    return result.checkoutUrl.slice(CHECKOUT_BASE.length);
  };

  /** Delivers a Stripe event JSON as the webhook would (after verification). */
  async function deliver(json: object): Promise<HandleProviderEventResult> {
    const raw = Buffer.from(JSON.stringify(json), 'utf8');
    const event: ProviderEvent = parseProviderEvent(raw);
    eventIds.push(event.id);
    return get(HandleProviderEventCommand).execute(
      event,
      createHash('sha256').update(raw).digest(),
      'WEBHOOK',
    );
  }

  async function checkoutOpen(
    buyer: string,
    courses: readonly TestCourse[],
    couponCode?: string,
  ): Promise<CheckoutResult> {
    for (const c of courses)
      await get(AddToCartCommand).execute({ userId: buyer, courseId: c.courseId });
    if (couponCode !== undefined) {
      await get(ApplyCouponCommand).execute({
        userId: buyer,
        ip: '198.51.100.7',
        code: couponCode,
      });
    }
    return get(CheckoutCommand).execute({
      userId: buyer,
      idempotencyKey: randomUUID(),
      expectedTotal: await total(buyer),
    });
  }

  async function linesOf(orderId: string): Promise<PaidLine[]> {
    return pg.db
      .selectFrom('commerce.orderLines')
      .select(['id', 'courseId', 'finalAmount', 'instructorShareAmount', 'platformShareAmount'])
      .where('orderId', '=', orderId)
      .orderBy('lineNo')
      .execute();
  }

  async function paidOrder(
    buyer: string,
    courses: readonly TestCourse[],
    couponCode?: string,
  ): Promise<PaidOrder> {
    const placed = await checkoutOpen(buyer, courses, couponCode);
    const sessionId = sessionIdOf(placed);
    const session = provider.completeSession(sessionId);
    expect((await deliver(provider.checkoutCompletedEvent(sessionId))).outcome).toBe('APPLIED');
    const lines = await linesOf(placed.orderId);
    return {
      orderId: placed.orderId,
      paymentIntentId: session.paymentIntentId ?? '',
      lines,
      line: (courseId) => {
        const found = lines.find((l) => l.courseId === courseId);
        if (found === undefined) throw new Error(`no line for ${courseId}`);
        return found;
      },
    };
  }

  const request = (buyer: string, order: PaidOrder, line: PaidLine, comment?: string) =>
    get(RequestRefundCommand).execute({
      userId: buyer,
      orderId: order.orderId,
      orderLineId: line.id,
      reasonCode: 'NOT_AS_EXPECTED',
      ...(comment === undefined ? {} : { comment }),
    });
  const dispatch = (refundIds: readonly string[]) =>
    get(CommerceJobs).dispatchRefunds({ refundIds });

  async function refundRow(refundId: string) {
    return pg.db
      .selectFrom('commerce.refunds')
      .select([
        'status',
        'attempt',
        'providerRefundId',
        'failureCode',
        'dispatchStartedAt',
        'initiatedBy',
        'reasonCode',
      ])
      .where('id', '=', refundId)
      .executeTakeFirstOrThrow();
  }

  async function refundLog(refundId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('commerce.refundTransitions')
      .select(['fromStatus', 'toStatus'])
      .where('refundId', '=', refundId)
      .orderBy('seq')
      .execute();
    return rows.map((r) => `${r.fromStatus ?? '-'}>${r.toStatus}`);
  }

  async function orderStatus(orderId: string): Promise<string> {
    return (
      await pg.db
        .selectFrom('commerce.orders')
        .select('status')
        .where('id', '=', orderId)
        .executeTakeFirstOrThrow()
    ).status;
  }

  async function enrollmentStatus(userId: string, courseId: string): Promise<string | null> {
    const row = await pg.db
      .selectFrom('enrollment.enrollments')
      .select('status')
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row?.status ?? null;
  }

  /** The order's outbox events, oldest first, each parsed with its contracts schema. */
  async function orderEvents(orderId: string): Promise<{ type: string; payload: unknown }[]> {
    const rows = await pg.db
      .selectFrom('outbox.events')
      .select(['type', 'payload'])
      .where('aggregateId', '=', orderId)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    const defs = new Map<string, EventDefinition>(
      COMMERCE_ORDER_EVENTS.map((d) => [`${d.type}.v${d.version}`, d]),
    );
    return rows.map((row) => {
      const def = defs.get(row.type);
      // The worker parses every payload with exactly these schemas (parseEvent).
      return {
        type: row.type,
        payload: def === undefined ? row.payload : def.parsePayload(row.payload),
      };
    });
  }

  const typesOf = async (orderId: string): Promise<string[]> =>
    (await orderEvents(orderId)).map((e) => e.type);

  async function providerRefundIdOf(refundId: string): Promise<string> {
    const row = await refundRow(refundId);
    if (row.providerRefundId === null) throw new Error(`refund ${refundId} has no provider refund`);
    return row.providerRefundId;
  }

  /**
   * Moves the whole order `days` into the past (replica mode, no guards; every column the
   * deferred log checks compare moves together, so later transactions still pass them).
   */
  async function agePayment(orderId: string, days: number): Promise<void> {
    await pg.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      const back = sql`make_interval(days => ${days})`;
      await sql`
        UPDATE commerce.orders
           SET placed_at = placed_at - ${back}, paid_at = paid_at - ${back}
         WHERE id = ${orderId}
      `.execute(trx);
      await sql`
        UPDATE commerce.order_transitions SET occurred_at = occurred_at - ${back} WHERE order_id = ${orderId}
      `.execute(trx);
      await sql`
        UPDATE commerce.payments
           SET created_at = created_at - ${back}, session_expires_at = session_expires_at - ${back},
               succeeded_at = succeeded_at - ${back}
         WHERE order_id = ${orderId}
      `.execute(trx);
    });
  }

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_PROVIDER)
      .useFactory({ factory: () => provider })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    await app.init();
    owner = await user('owner');
    admin = await user('admin');
    provider.refundOutcome = 'PENDING';
  });

  beforeEach(async () => {
    if (!available()) return;
    provider.refundOutcome = 'PENDING';
    const keys = commerceRateLimitTestKeys({ userIds });
    if (keys.length > 0) await itRedis.redis.del(...keys);
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (available()) {
        const keys = commerceRateLimitTestKeys({ userIds, courseIds });
        if (keys.length > 0) await itRedis.redis.del(...keys);
        await deleteCommerceTestData(pg.db, { userIds, courseIds });
        await deleteProviderEvents(pg.db, eventIds);
      }
    } finally {
      await rm(IT_APP_ENV.keysDir, { recursive: true, force: true });
      process.env = IT_APP_ENV.savedEnv;
    }
  });

  /* ------------------------------------------------------------------ the happy path */

  it('request within the window: APPROVED at once (revoked at approval), dispatched (SUBMITTED), refund.updated -> SUCCEEDED, order REFUNDED, RefundSucceeded for the ledger; replays are no-ops', async (ctx) => {
    skip(ctx);
    const buyer = await user('happy');
    const c = await course('19.99');
    const order = await paidOrder(buyer, [c]);
    const line = order.line(c.courseId);
    expect(await enrollmentStatus(buyer, c.courseId)).toBe('ACTIVE');

    const refund = await request(buyer, order, line, 'Not what the outline promised.');
    expect(refund).toMatchObject({
      status: 'APPROVED',
      initiatedBy: 'STUDENT',
      amount: '19.99',
      currency: 'USD',
      attempt: 1,
      comment: 'Not what the outline promised.',
      rejectionReason: null,
    });
    expect(await enrollmentStatus(buyer, c.courseId)).toBe('REVOKED');
    expect(await typesOf(order.orderId)).toEqual([
      'OrderPlaced.v1',
      'OrderPaid.v1',
      'RefundApproved.v1',
    ]);

    expect(await dispatch([refund.id])).toMatchObject({ locked: true, leased: 1, submitted: 1 });
    const createCalls = provider.calls.filter(
      (c2) => c2.operation === 'createRefund' && c2.idempotencyKey === `refund:${refund.id}:1`,
    );
    expect(createCalls).toHaveLength(1);
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'SUBMITTED',
      dispatchStartedAt: null,
    });
    // A second run finds nothing to send.
    expect(await dispatch([refund.id])).toMatchObject({ leased: 0 });

    const prid = await providerRefundIdOf(refund.id);
    provider.setRefundStatus(prid, 'SUCCEEDED');
    const succeeded = provider.refundEvent(prid);
    expect(await deliver(succeeded)).toEqual({ outcome: 'APPLIED', orderId: order.orderId });
    expect(await deliver(succeeded)).toEqual({ outcome: 'DUPLICATE', orderId: null });
    // A different event id with the same state (Stripe may send both): no second effect.
    expect(await deliver(provider.refundEvent(prid))).toEqual({
      outcome: 'DUPLICATE_EFFECT',
      orderId: order.orderId,
    });
    expect(await refundRow(refund.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await refundLog(refund.id)).toEqual([
      '->APPROVED',
      'APPROVED>SUBMITTED',
      'SUBMITTED>SUCCEEDED',
    ]);
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');

    const events = await orderEvents(order.orderId);
    expect(events.map((e) => e.type)).toEqual([
      'OrderPlaced.v1',
      'OrderPaid.v1',
      'RefundApproved.v1',
      'RefundSucceeded.v1',
    ]);
    // What payouts.ledger-writer mirrors: the line's SQL-generated 70% split.
    expect(RefundSucceeded.parsePayload(events[3]?.payload)).toMatchObject({
      refundId: refund.id,
      orderId: order.orderId,
      orderLineId: line.id,
      userId: buyer,
      courseId: c.courseId,
      instructorId: owner,
      currency: 'USD',
      amount: '19.99',
      instructorShareAmount: '13.99',
      platformShareAmount: '6.00',
    });
    const detail = await get(GetMyOrderQuery).execute({ userId: buyer, orderId: order.orderId });
    expect(detail).toMatchObject({ status: 'REFUNDED', refundedAmount: '19.99' });
    expect(detail.lines[0]?.refund).toMatchObject({
      status: 'SUCCEEDED',
      eligible: false,
      reason: ErrorCode.RefundAlreadyRequested,
    });
    expect(await findActiveEnrollmentsWithLiveRefund(pg.db, { userIds: [buyer] })).toEqual([]);
    expect(await findOrderEnrollmentsWithoutPaidLine(pg.db, { userIds: [buyer] })).toEqual([]);
  });

  it('partial refunds: one line -> PARTIALLY_REFUNDED (synchronous provider success), the other -> REFUNDED', async (ctx) => {
    skip(ctx);
    const buyer = await user('partial');
    const a = await course('19.99');
    const b = await course('24.99');
    const order = await paidOrder(buyer, [a, b]);
    provider.refundOutcome = 'SUCCEEDED';
    const first = await request(buyer, order, order.line(a.courseId));
    expect(await dispatch([first.id])).toMatchObject({ succeeded: 1 });
    expect(await orderStatus(order.orderId)).toBe('PARTIALLY_REFUNDED');
    expect(await enrollmentStatus(buyer, b.courseId)).toBe('ACTIVE');
    const second = await request(buyer, order, order.line(b.courseId));
    expect(await dispatch([second.id])).toMatchObject({ succeeded: 1 });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
    expect((await typesOf(order.orderId)).filter((t) => t === 'RefundSucceeded.v1')).toHaveLength(
      2,
    );
  });

  /* ------------------------------------------------------------------ eligibility */

  it('eligibility: window closed (422), already requested (409), foreign order / foreign line (404); 0.00 lines are not refundable', async (ctx) => {
    skip(ctx);
    const buyer = await user('eligibility');
    const stranger = await user('stranger');
    const a = await course('19.99');
    const b = await course('19.99');
    const order = await paidOrder(buyer, [a, b]);
    const other = await paidOrder(stranger, [await course('19.99')]);

    await expect(request(stranger, order, order.line(a.courseId))).rejects.toMatchObject({
      code: ErrorCode.OrderNotFound,
    });
    await expect(request(buyer, order, nth(other.lines, 0))).rejects.toMatchObject({
      code: ErrorCode.OrderNotFound,
    });
    const live = await request(buyer, order, order.line(a.courseId));
    await expect(request(buyer, order, order.line(a.courseId))).rejects.toMatchObject({
      code: ErrorCode.RefundAlreadyRequested,
    });
    expect(live.status).toBe('APPROVED');

    await agePayment(order.orderId, 31);
    await expect(request(buyer, order, order.line(b.courseId))).rejects.toMatchObject({
      code: ErrorCode.RefundWindowClosed,
    });
    const detail = await get(GetMyOrderQuery).execute({ userId: buyer, orderId: order.orderId });
    expect(detail.lines.find((l) => l.courseId === b.courseId)?.refund).toMatchObject({
      eligible: false,
      reason: ErrorCode.RefundWindowClosed,
    });
    // An admin refund ignores the window.
    const [byAdmin] = await get(AdminRefundOrderLinesCommand).execute({
      adminId: admin,
      orderId: order.orderId,
      orderLineIds: [order.line(b.courseId).id],
      reason: 'Goodwill refund after the window.',
    });
    expect(byAdmin).toMatchObject({
      status: 'APPROVED',
      initiatedBy: 'ADMIN',
      reasonCode: 'ADMIN_DISCRETION',
      comment: null,
      requestedBy: admin,
    });
    expect(await enrollmentStatus(buyer, b.courseId)).toBe('REVOKED');

    // A 100% coupon line (0.00) of a zero-total order has nothing to refund.
    const free = await course('29.99');
    const code = testCouponCode('FULL');
    await insertTestCoupon(pg.db, {
      createdBy: owner,
      courseId: free.courseId,
      code,
      percentOff: 100,
    });
    const zeroBuyer = await user('zero');
    const placed = await checkoutOpen(zeroBuyer, [free], code);
    expect(placed.status).toBe('PAID');
    const [zeroLine] = await linesOf(placed.orderId);
    await expect(
      get(RequestRefundCommand).execute({
        userId: zeroBuyer,
        orderId: placed.orderId,
        orderLineId: zeroLine?.id ?? '',
        reasonCode: 'OTHER',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RefundNotApplicable });
  });

  it('rate limit: the 6th refund request in 24 h is 429 (every attempt counts)', async (ctx) => {
    skip(ctx);
    const buyer = await user('limit');
    const c = await course('19.99');
    const order = await paidOrder(buyer, [c]);
    await request(buyer, order, order.line(c.courseId));
    for (let i = 0; i < 4; i += 1) {
      await expect(request(buyer, order, order.line(c.courseId))).rejects.toMatchObject({
        code: ErrorCode.RefundAlreadyRequested,
      });
    }
    await expect(request(buyer, order, order.line(c.courseId))).rejects.toMatchObject({
      code: ErrorCode.RateLimited,
    });
  });

  /* ------------------------------------------------------------------ abuse rule + review */

  it('>= 3 refunds in 90 days -> REQUESTED (RefundRequested, access kept); admin approve -> APPROVED + revoke; admin reject -> REJECTED + RefundRejected; the queue shows the count the rule saw', async (ctx) => {
    skip(ctx);
    const buyer = await user('abuser');
    const courses: TestCourse[] = [];
    for (let i = 0; i < 5; i += 1) courses.push(await course('19.99'));
    const order = await paidOrder(buyer, courses);
    const refunds: Awaited<ReturnType<typeof request>>[] = [];
    for (const c of courses) refunds.push(await request(buyer, order, order.line(c.courseId)));
    expect(refunds.map((r) => r.status)).toEqual([
      'APPROVED',
      'APPROVED',
      'APPROVED',
      'REQUESTED',
      'REQUESTED',
    ]);
    const fourth = nth(refunds, 3);
    const fifth = nth(refunds, 4);
    expect(await enrollmentStatus(buyer, courses[3]?.courseId ?? '')).toBe('ACTIVE');
    expect((await typesOf(order.orderId)).filter((t) => t === 'RefundRequested.v1')).toHaveLength(
      2,
    );

    const queue = await get(ListRefundQueueQuery).execute({ status: 'REQUESTED', limit: 100 });
    const mine = queue.items.filter((i) => i.userId === buyer);
    expect(mine.map((i) => [i.id, i.recentRefundCount])).toEqual([
      [fourth.id, 3],
      [fifth.id, 4],
    ]);
    expect(mine[0]?.buyer?.email).toContain('commerce-it-abuser');

    const approved = await get(ReviewRefundCommand).execute({
      adminId: admin,
      refundId: fourth.id,
      decision: 'approve',
      reason: 'Reviewed: genuine.',
    });
    expect(approved).toMatchObject({ status: 'APPROVED', recentRefundCount: 3 });
    expect(await enrollmentStatus(buyer, courses[3]?.courseId ?? '')).toBe('REVOKED');
    await expect(
      get(ReviewRefundCommand).execute({
        adminId: admin,
        refundId: fourth.id,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidStateTransition });

    const rejected = await get(ReviewRefundCommand).execute({
      adminId: admin,
      refundId: fifth.id,
      decision: 'reject',
      reason: 'You watched the whole course already.',
    });
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'You watched the whole course already.',
      approvedAt: null,
    });
    expect(await enrollmentStatus(buyer, courses[4]?.courseId ?? '')).toBe('ACTIVE');
    const events = await orderEvents(order.orderId);
    expect(events.find((e) => e.type === 'RefundRejected.v1')?.payload).toMatchObject({
      refundId: fifth.id,
      userId: buyer,
      reason: 'You watched the whole course already.',
    });
    expect(events.filter((e) => e.type === 'RefundApproved.v1').at(-1)?.payload).toMatchObject({
      refundId: fourth.id,
      initiatedBy: 'STUDENT',
      approvedBy: admin,
    });
    expect(await refundLog(fifth.id)).toEqual(['->REQUESTED', 'REQUESTED>REJECTED']);
    // A rejected request no longer blocks the line.
    const detail = await get(GetMyOrderQuery).execute({ userId: buyer, orderId: order.orderId });
    expect(detail.lines.find((l) => l.courseId === courses[4]?.courseId)?.refund).toMatchObject({
      status: 'REJECTED',
      eligible: true,
    });
    await expect(
      get(ReviewRefundCommand).execute({
        adminId: admin,
        refundId: randomUUID(),
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RefundNotFound });
  });

  /* ------------------------------------------------------------------ provider failures */

  it('provider refusal -> FAILED + RefundFailed; retry -> APPROVED attempt 2 with a NEW idempotency key; a late event of attempt 1 is a no-op; an outage releases the lease', async (ctx) => {
    skip(ctx);
    const buyer = await user('failure');
    const c = await course('19.99');
    const order = await paidOrder(buyer, [c]);
    const refund = await request(buyer, order, order.line(c.courseId));

    // Dual package: the API's instanceof checks need the CommonJS main entry's error class.
    provider.failNext(
      'createRefund',
      new PaymentInvalidRequestError('Charge disputed', {
        operation: 'createRefund',
        providerCode: 'charge_disputed',
        httpStatus: 400,
      }),
    );
    expect(await dispatch([refund.id])).toMatchObject({ failed: 1 });
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'charge_disputed',
    });
    const failedEvent = (await orderEvents(order.orderId)).find(
      (e) => e.type === 'RefundFailed.v1',
    );
    expect(failedEvent?.payload).toMatchObject({
      refundId: refund.id,
      failureCode: 'charge_disputed',
      attempt: 1,
    });
    expect(
      (await get(ListRefundQueueQuery).execute({ status: 'FAILED', limit: 100 })).items.some(
        (i) => i.id === refund.id,
      ),
    ).toBe(true);

    const retried = await get(ReviewRefundCommand).execute({
      adminId: admin,
      refundId: refund.id,
      decision: 'retry',
    });
    expect(retried).toMatchObject({ status: 'APPROVED', attempt: 2, failureCode: null });

    // Outage: the lease is given back and the next run sends it.
    provider.failNext(
      'createRefund',
      new PaymentProviderUnavailableError({ operation: 'createRefund' }),
    );
    expect(await dispatch([refund.id])).toMatchObject({ released: 1 });
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'APPROVED',
      dispatchStartedAt: null,
    });
    expect(await dispatch([refund.id])).toMatchObject({ submitted: 1 });
    expect(
      provider.calls
        .filter((call) => call.operation === 'createRefund')
        .map((call) => call.idempotencyKey)
        .filter((key) => key?.startsWith(`refund:${refund.id}:`)),
    ).toEqual([`refund:${refund.id}:1`, `refund:${refund.id}:2`, `refund:${refund.id}:2`]);

    // provider failure after SUBMITTED (refund.failed) -> FAILED (attempt 2), then a retry ...
    const second = await providerRefundIdOf(refund.id);
    provider.setRefundStatus(second, 'FAILED');
    expect(await deliver(provider.refundEvent(second))).toEqual({
      outcome: 'APPLIED',
      orderId: order.orderId,
    });
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'expired_or_canceled_card',
      attempt: 2,
    });
    await get(ReviewRefundCommand).execute({
      adminId: admin,
      refundId: refund.id,
      decision: 'retry',
    });
    // ... and attempt 2's late refund.failed must not fail attempt 3.
    expect(
      await deliver(
        refundFailedEvent({
          providerRefundId: second,
          refundId: refund.id,
          paymentIntentId: order.paymentIntentId,
          amountMinor: 1999,
        }),
      ),
    ).toEqual({ outcome: 'DUPLICATE_EFFECT', orderId: order.orderId });
    expect(await refundRow(refund.id)).toMatchObject({ status: 'APPROVED', attempt: 3 });
    expect(await refundLog(refund.id)).toEqual([
      '->APPROVED',
      'APPROVED>FAILED',
      'FAILED>APPROVED',
      'APPROVED>SUBMITTED',
      'SUBMITTED>FAILED',
      'FAILED>APPROVED',
    ]);
  });

  /* ------------------------------------------------------------------ concurrency and fencing */

  it('two dispatchers at once send the refund once; a crashed claim is replayed with the same key (the same provider refund)', async (ctx) => {
    skip(ctx);
    const buyer = await user('race');
    const c = await course('19.99');
    const order = await paidOrder(buyer, [c]);
    const refund = await request(buyer, order, order.line(c.courseId));
    const reports = await Promise.all([dispatch([refund.id]), dispatch([refund.id])]);
    expect(reports.reduce((n, r) => n + r.submitted, 0)).toBe(1);
    const sent = () =>
      provider.calls.filter(
        (call) =>
          call.operation === 'createRefund' &&
          call.idempotencyKey?.startsWith(`refund:${refund.id}:`),
      );
    expect(sent()).toHaveLength(1);

    // A dispatcher that leased and crashed before tx2: the stale lease is taken again, the key
    // is replayed and the provider answers the SAME refund (no second money movement).
    const otherOrder = await paidOrder(buyer, [await course('24.99')]);
    const other = await request(buyer, otherOrder, nth(otherOrder.lines, 0));
    const leased = await get(RefundDispatchRepository).lease({
      batchSize: 5,
      staleLeaseSeconds: 120,
      refundIds: [other.id],
    });
    expect(leased.refunds.map((r) => r.id)).toEqual([other.id]);
    const crashed = await provider.createRefund(
      {
        paymentIntentId: leased.refunds[0]?.paymentIntentId ?? '',
        amountMinor: 2499,
        refundId: other.id,
        metadata: { orderId: leased.refunds[0]?.orderId ?? '' },
      },
      { idempotencyKey: `refund:${other.id}:1` },
    );
    expect(await dispatch([other.id])).toMatchObject({ leased: 0 }); // the lease is fresh
    await pg.db.transaction().execute(async (trx) => {
      await sql`
        UPDATE commerce.refunds SET dispatch_started_at = now() - interval '3 minutes' WHERE id = ${other.id}
      `.execute(trx);
    });
    expect(await dispatch([other.id])).toMatchObject({ leased: 1, submitted: 1 });
    expect(await providerRefundIdOf(other.id)).toBe(crashed.providerRefundId);
  });

  it('the webhook wins the race with tx2: SUCCEEDED once, the dispatcher outcome is a fenced no-op', async (ctx) => {
    skip(ctx);
    const buyer = await user('webhook-first');
    const c = await course('19.99');
    const order = await paidOrder(buyer, [c]);
    const refund = await request(buyer, order, order.line(c.courseId));
    provider.refundOutcome = 'SUCCEEDED';
    const original = provider.createRefund.bind(provider);
    const spy = vi.spyOn(provider, 'createRefund').mockImplementation(async (input, options) => {
      const created = await original(input, options);
      // refund.updated (metadata.refundId only) is processed while the refund is still APPROVED.
      expect(await deliver(provider.refundEvent(created.providerRefundId))).toMatchObject({
        outcome: 'APPLIED',
      });
      return created;
    });
    try {
      expect(await dispatch([refund.id])).toMatchObject({ leased: 1, lost: 1, succeeded: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(await refundRow(refund.id)).toMatchObject({
      status: 'SUCCEEDED',
      dispatchStartedAt: null,
    });
    expect(await refundLog(refund.id)).toEqual(['->APPROVED', 'APPROVED>SUCCEEDED']);
    expect((await typesOf(order.orderId)).filter((t) => t === 'RefundSucceeded.v1')).toHaveLength(
      1,
    );
  });

  /* ------------------------------------------------------------------ charge.refunded */

  it('charge.refunded (no refund ids): settles the only SUBMITTED refund of the new amount; repeats are DUPLICATE_EFFECT; ambiguous is IGNORED; more than we sent is ORPHAN', async (ctx) => {
    skip(ctx);
    const buyer = await user('charge');
    const a = await course('19.99');
    const b = await course('24.99');
    const d = await course('24.99');
    const order = await paidOrder(buyer, [a, b, d]);
    const ra = await request(buyer, order, order.line(a.courseId));
    const rb = await request(buyer, order, order.line(b.courseId));
    const rd = await request(buyer, order, order.line(d.courseId));
    await dispatch([ra.id, rb.id, rd.id]);
    const charge = (refunded: number) =>
      chargeRefundedEvent({
        paymentIntentId: order.paymentIntentId,
        amountMinor: 6997,
        amountRefundedMinor: refunded,
      });

    // 24.99 matches two SUBMITTED refunds: ambiguous, refund.updated will tell.
    expect(await deliver(charge(2499))).toEqual({ outcome: 'IGNORED', orderId: order.orderId });
    // 19.99 matches exactly one.
    expect(await deliver(charge(1999))).toEqual({ outcome: 'APPLIED', orderId: order.orderId });
    expect((await refundRow(ra.id)).status).toBe('SUCCEEDED');
    expect(await orderStatus(order.orderId)).toBe('PARTIALLY_REFUNDED');
    expect(await deliver(charge(1999))).toEqual({
      outcome: 'DUPLICATE_EFFECT',
      orderId: order.orderId,
    });
    // The per-refund event of the same refund afterwards: no second effect.
    const praId = await providerRefundIdOf(ra.id);
    provider.setRefundStatus(praId, 'SUCCEEDED');
    expect(await deliver(provider.refundEvent(praId))).toMatchObject({
      outcome: 'DUPLICATE_EFFECT',
    });
    // Both 24.99 refunds at once: the remaining SUBMITTED refunds add up exactly.
    expect(await deliver(charge(6997))).toEqual({ outcome: 'APPLIED', orderId: order.orderId });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
    expect((await typesOf(order.orderId)).filter((t) => t === 'RefundSucceeded.v1')).toHaveLength(
      3,
    );

    // A charge of another order that we never refunded: more than we sent.
    const other = await paidOrder(buyer, [await course('19.99')]);
    expect(
      await deliver(
        chargeRefundedEvent({
          paymentIntentId: other.paymentIntentId,
          amountMinor: 1999,
          amountRefundedMinor: 1999,
        }),
      ),
    ).toEqual({ outcome: 'ORPHAN', orderId: other.orderId });
    expect(await deliver(chargeRefundedEvent({ amountRefundedMinor: 100 }))).toEqual({
      outcome: 'ORPHAN',
      orderId: null,
    });
    // A refund webhook with an amount that is not the line's: MISMATCH, nothing changes.
    const prd = await providerRefundIdOf(rd.id);
    expect(
      await deliver(
        refundUpdatedEvent({
          providerRefundId: prd,
          refundId: rd.id,
          paymentIntentId: order.paymentIntentId,
          amountMinor: 1,
        }),
      ),
    ).toEqual({ outcome: 'MISMATCH', orderId: order.orderId });
  });

  /* ------------------------------------------------------------------ D15 and the kick */

  it('D15: the duplicate-purchase refund is dispatched by the post-commit kick and keeps the access granted by the first purchase', async (ctx) => {
    skip(ctx);
    const settings = get(CommerceSettings);
    const buyer = await user('duplicate');
    const c = await course('19.99');
    const placed = await checkoutOpen(buyer, [c]);
    await insertTestEnrollment(pg.db, buyer, c.courseId);
    const sessionId = sessionIdOf(placed);
    provider.completeSession(sessionId);
    Object.defineProperty(settings, 'jobsEnabled', { value: true, configurable: true });
    try {
      expect((await deliver(provider.checkoutCompletedEvent(sessionId))).outcome).toBe('APPLIED');
      await get(RefundDispatcher).whenIdle();
    } finally {
      Object.defineProperty(settings, 'jobsEnabled', { value: false, configurable: true });
    }
    const refunds = await pg.db
      .selectFrom('commerce.refunds')
      .select(['id', 'status', 'initiatedBy', 'reasonCode'])
      .where('orderId', '=', placed.orderId)
      .execute();
    expect(refunds).toEqual([
      expect.objectContaining({
        status: 'SUBMITTED',
        initiatedBy: 'SYSTEM',
        reasonCode: 'DUPLICATE_PURCHASE',
      }),
    ]);
    // The FREE enrollment the buyer already had is untouched (it was not granted by this line).
    expect(await enrollmentStatus(buyer, c.courseId)).toBe('ACTIVE');
    const prid = await providerRefundIdOf(refunds[0]?.id ?? '');
    provider.setRefundStatus(prid, 'SUCCEEDED');
    expect(await deliver(provider.refundEvent(prid))).toMatchObject({ outcome: 'APPLIED' });
    expect(await orderStatus(placed.orderId)).toBe('REFUNDED');
    expect(await enrollmentStatus(buyer, c.courseId)).toBe('ACTIVE');
  });

  /* ------------------------------------------------------------------ PAYMENT_REVIEW */

  async function mismatchedOrder(buyer: string, courses: readonly TestCourse[]) {
    const placed = await checkoutOpen(buyer, courses);
    const sessionId = sessionIdOf(placed);
    const session = provider.completeSession(sessionId);
    const charged = (session.amountTotalMinor ?? 0) + 100; // charged 1.00 more than the order
    provider.registerPayment(session.paymentIntentId ?? '', charged);
    expect(
      (
        await deliver(
          checkoutSessionCompletedEvent({
            sessionId,
            orderId: placed.orderId,
            clientReferenceId: placed.orderId,
            amountTotalMinor: charged,
            currency: 'USD',
            paymentIntentId: session.paymentIntentId,
            paymentStatus: 'paid',
          }),
        )
      ).outcome,
    ).toBe('MISMATCH');
    return { orderId: placed.orderId, lines: await linesOf(placed.orderId) };
  }

  it('PAYMENT_REVIEW accept: PAID with enrollments (ADMIN transition, OrderPaid), the refund window starts; a second accept is 409', async (ctx) => {
    skip(ctx);
    const buyer = await user('review-accept');
    const c = await course('19.99');
    const order = await mismatchedOrder(buyer, [c]);
    expect(await enrollmentStatus(buyer, c.courseId)).toBeNull();
    const detail = await get(AcceptPaymentCommand).execute({
      adminId: admin,
      orderId: order.orderId,
      reason: 'Customer overpaid by 1.00; accepted.',
    });
    expect(detail).toMatchObject({ status: 'PAID', settlement: 'STRIPE' });
    expect(detail.paidAt).not.toBeNull();
    expect(detail.transitions.at(-1)).toMatchObject({
      fromStatus: 'PAYMENT_REVIEW',
      toStatus: 'PAID',
      cause: 'ADMIN',
      actorId: admin,
      actor: { id: admin, displayName: 'Commerce IT admin' },
      reason: 'Customer overpaid by 1.00; accepted.',
    });
    expect(await enrollmentStatus(buyer, c.courseId)).toBe('ACTIVE');
    expect(await typesOf(order.orderId)).toEqual([
      'OrderPlaced.v1',
      'OrderPaymentMismatch.v1',
      'OrderPaid.v1',
    ]);
    await expect(
      get(AcceptPaymentCommand).execute({
        adminId: admin,
        orderId: order.orderId,
        reason: 'Accept it twice.',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidStateTransition });
    // Now an ordinary paid order: the student can request a refund.
    const lines = await linesOf(order.orderId);
    const refund = await get(RequestRefundCommand).execute({
      userId: buyer,
      orderId: order.orderId,
      orderLineId: lines[0]?.id ?? '',
      reasonCode: 'ACCIDENTAL_PURCHASE',
    });
    expect(refund.status).toBe('APPROVED');
  });

  it('PAYMENT_REVIEW refund: the whole order only (422 otherwise), reason PAYMENT_REVIEW, no enrollment to revoke; settled -> REFUNDED; accept is then 409', async (ctx) => {
    skip(ctx);
    const buyer = await user('review-refund');
    const a = await course('19.99');
    const b = await course('24.99');
    const order = await mismatchedOrder(buyer, [a, b]);
    await expect(
      get(AdminRefundOrderLinesCommand).execute({
        adminId: admin,
        orderId: order.orderId,
        orderLineIds: [order.lines[0]?.id ?? ''],
        reason: 'Refund the mismatched payment.',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RefundNotApplicable });
    provider.refundOutcome = 'SUCCEEDED';
    const created = await get(AdminRefundOrderLinesCommand).execute({
      adminId: admin,
      orderId: order.orderId,
      orderLineIds: order.lines.map((l) => l.id),
      reason: 'Refund the mismatched payment.',
    });
    expect(created.map((r) => [r.orderLineId, r.reasonCode, r.status])).toEqual(
      order.lines.map((l) => [l.id, 'PAYMENT_REVIEW', 'APPROVED']),
    );
    await expect(
      get(AcceptPaymentCommand).execute({
        adminId: admin,
        orderId: order.orderId,
        reason: 'Too late to accept.',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidStateTransition });
    expect(await dispatch(created.map((r) => r.id))).toMatchObject({ succeeded: 2 });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
    expect(await enrollmentStatus(buyer, a.courseId)).toBeNull();
  });

  /* ------------------------------------------------------------------ admin views */

  it('admin search (order number, buyer email, status, course, range) and detail with the merged timeline and actor names', async (ctx) => {
    skip(ctx);
    const buyer = await user('searchable');
    const c = await course('19.99');
    const order = await paidOrder(buyer, [c]);
    const refund = await request(buyer, order, order.line(c.courseId));
    await dispatch([refund.id]);
    const email = (
      await pg.db
        .selectFrom('identity.users')
        .select('email')
        .where('id', '=', buyer)
        .executeTakeFirstOrThrow()
    ).email;
    const fragment = email.slice('commerce-it-searchable-'.length, email.indexOf('@'));
    const search = get(SearchAdminOrdersQuery);
    const byEmail = await search.execute({ buyerEmail: fragment.toUpperCase(), limit: 20 });
    expect(byEmail.items.map((i) => i.id)).toEqual([order.orderId]);
    expect(byEmail.items[0]).toMatchObject({
      buyer: { id: buyer, email },
      lineCount: 1,
      totalAmount: '19.99',
    });
    const header = await pg.db
      .selectFrom('commerce.orders')
      .select(['orderNumber', 'placedAt'])
      .where('id', '=', order.orderId)
      .executeTakeFirstOrThrow();
    expect(
      (await search.execute({ q: Number(header.orderNumber), limit: 20 })).items.map((i) => i.id),
    ).toEqual([order.orderId]);
    expect(
      (await search.execute({ courseId: c.courseId, status: 'PAID', limit: 20 })).items.map(
        (i) => i.id,
      ),
    ).toEqual([order.orderId]);
    expect(
      (await search.execute({ courseId: c.courseId, status: 'REFUNDED', limit: 20 })).items,
    ).toEqual([]);
    expect(
      (
        await search.execute({
          userId: buyer,
          from: new Date(header.placedAt.getTime() - DAY_MS).toISOString(),
          to: new Date(header.placedAt.getTime() + DAY_MS).toISOString(),
          limit: 20,
        })
      ).items.map((i) => i.id),
    ).toEqual([order.orderId]);
    expect((await search.execute({ buyerEmail: `zz${randomUUID()}`, limit: 20 })).items).toEqual(
      [],
    );

    const detail = await get(GetAdminOrderQuery).execute(order.orderId);
    expect(detail.lines[0]).toMatchObject({
      revenueShareBps: 7000,
      instructorShareAmount: '13.99',
      platformShareAmount: '6.00',
    });
    expect(detail.payment).toMatchObject({
      id: order.orderId,
      status: 'SUCCEEDED',
      paymentIntentId: order.paymentIntentId,
    });
    expect(detail.refunds[0]).toMatchObject({ id: refund.id, status: 'SUBMITTED' });
    expect(detail.refunds[0]?.transitions.map((t) => t.toStatus)).toEqual([
      'APPROVED',
      'SUBMITTED',
    ]);
    expect(detail.refunds[0]?.transitions[0]?.actor).toEqual({
      id: buyer,
      displayName: 'Commerce IT searchable',
    });
    expect(detail.transitions[0]?.actor).toEqual({
      id: buyer,
      displayName: 'Commerce IT searchable',
    });
    expect(detail.timeline.map((e) => `${e.kind}:${e.toStatus}`)).toEqual([
      'ORDER:PENDING_PAYMENT',
      'PAYMENT:CREATING',
      'ORDER:PAID',
      'PAYMENT:SUCCEEDED',
      'REFUND:APPROVED',
      'REFUND:SUBMITTED',
    ]);
    expect(detail.providerEvents.map((e) => e.type)).toEqual(['checkout.session.completed']);
    await expect(get(GetAdminOrderQuery).execute(randomUUID())).rejects.toMatchObject({
      code: ErrorCode.OrderNotFound,
    });
    const submitted = await get(ListRefundQueueQuery).execute({ status: 'SUBMITTED', limit: 100 });
    expect(submitted.items.some((i) => i.id === refund.id)).toBe(true);
  });

  /* ------------------------------------------------------------------ instructor sales */

  it('instructor sales: totals and per course match the SQL 70% share (refunds subtract); another instructor sees nothing; recent sales page by keyset', async (ctx) => {
    skip(ctx);
    const teacher = await user('teacher');
    const a = await course('19.99', teacher);
    const b = await course('24.99', teacher);
    const code = testCouponCode('HALF');
    await insertTestCoupon(pg.db, {
      createdBy: teacher,
      courseId: b.courseId,
      code,
      percentOff: 50,
    });
    const first = await user('sales-1');
    const second = await user('sales-2');
    await paidOrder(first, [a, b], code);
    const secondOrder = await paidOrder(second, [a]);
    provider.refundOutcome = 'SUCCEEDED';
    const refund = await request(second, secondOrder, secondOrder.line(a.courseId));
    await dispatch([refund.id]);

    const now = Date.now();
    const summary = await get(GetSalesSummaryQuery).execute(teacher, {
      from: new Date(now - DAY_MS).toISOString(),
      to: new Date(now + DAY_MS).toISOString(),
    });
    expect(summary.currency).toBe('USD');
    expect(summary.totals).toEqual({
      salesCount: 3,
      refundCount: 1,
      gross: '64.97',
      discounts: '12.50',
      refunded: '19.99',
      net: '32.48',
      instructorShare: '22.73', // 13.99 + 8.74 + 13.99 - 13.99
    });
    expect(summary.courses).toEqual([
      {
        courseId: a.courseId,
        courseTitle: a.title,
        salesCount: 2,
        refundCount: 1,
        gross: '39.98',
        discounts: '0.00',
        refunded: '19.99',
        net: '19.99',
        instructorShare: '13.99',
      },
      {
        courseId: b.courseId,
        courseTitle: b.title,
        salesCount: 1,
        refundCount: 0,
        gross: '24.99',
        discounts: '12.50',
        refunded: '0.00',
        net: '12.49',
        instructorShare: '8.74',
      },
    ]);
    const nobody = await user('other-teacher');
    expect(
      (
        await get(GetSalesSummaryQuery).execute(nobody, {
          from: new Date(now - DAY_MS).toISOString(),
          to: new Date(now + DAY_MS).toISOString(),
        })
      ).totals,
    ).toMatchObject({ salesCount: 0, net: '0.00', instructorShare: '0.00' });
    expect((await get(ListRecentSalesQuery).execute(nobody, { limit: 10 })).items).toEqual([]);

    const recent = get(ListRecentSalesQuery);
    const page1 = await recent.execute(teacher, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await recent.execute(teacher, { limit: 2, cursor: page1.nextCursor ?? '' });
    const all = [...page1.items, ...page2.items];
    expect(all).toHaveLength(3);
    expect(page2.nextCursor).toBeNull();
    expect(all.filter((s) => s.refunded).map((s) => s.orderLineId)).toEqual([
      secondOrder.line(a.courseId).id,
    ]);
    expect(all.find((s) => s.courseId === b.courseId)).toMatchObject({
      listAmount: '24.99',
      finalAmount: '12.49',
      couponCode: code,
      instructorShareAmount: '8.74',
    });
    expect(
      (await recent.execute(teacher, { limit: 10, courseId: b.courseId })).items.map(
        (s) => s.courseId,
      ),
    ).toEqual([b.courseId]);
  });
});
