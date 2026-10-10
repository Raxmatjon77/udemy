// Must stay the first import: AppModule validates process.env when it is imported.
import { IT_APP_ENV } from '../../testing/apply-it-app-env';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  COMMERCE_ORDER_AGGREGATE,
  ErrorCode,
  OrderDetailSchema,
  OrderPaid,
  OrderSummaryPageSchema,
  ReceiptSchema,
} from '@udemy/contracts';
import { type DB, type Executor, type Kysely, sql } from '@udemy/db';
import {
  PAYMENT_PROVIDER,
  PaymentProviderUnavailableError,
  type ProviderEvent,
  parseProviderEvent,
} from '@udemy/payments';
import {
  chargeDisputeCreatedEvent,
  checkoutSessionCompletedEvent,
  checkoutSessionExpiredEvent,
  InMemoryPaymentProvider,
  refundUpdatedEvent,
  stripeEvent,
} from '@udemy/payments/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS } from '../../setup-app';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { CommerceJobs } from './application/commerce-jobs';
import {
  type OverdueOpenSessionRecord,
  ReconcileRepository,
  type StaleCreatingPaymentRecord,
} from './application/ports/reconcile.repository';
import { AddToCartCommand } from './application/use-cases/add-to-cart.command';
import { ApplyCouponCommand } from './application/use-cases/apply-coupon.command';
import { CancelPendingOrderCommand } from './application/use-cases/cancel-pending-order.command';
import { type CheckoutResult, CheckoutCommand } from './application/use-cases/checkout.command';
import { GetCartQuery } from './application/use-cases/get-cart.query';
import { GetMyOrderQuery } from './application/use-cases/get-my-order.query';
import { GetReceiptQuery } from './application/use-cases/get-receipt.query';
import {
  type HandleProviderEventResult,
  HandleProviderEventCommand,
} from './application/use-cases/handle-provider-event.command';
import { ListMyOrdersQuery } from './application/use-cases/list-my-orders.query';
import {
  AmountBelowMinimum,
  CartChanged,
  CartEmpty,
  CheckoutEmailNotVerified,
  CheckoutInProgress,
  IdempotencyKeyReused,
  OrderNotCancelable,
  OrderNotFound,
  OrderNotPaid,
  PaymentProviderUnavailable,
  PriceChanged,
} from './domain/commerce.errors';
import { KyselyReconcileRepository } from './infrastructure/kysely-reconcile.repository';
import {
  commerceRateLimitTestKeys,
  deleteCommerceTestData,
  deleteProviderEvents,
  insertCommerceTestUser,
  insertTestCoupon,
  insertTestCourse,
  insertTestEnrollment,
  setTestCourseStatus,
  setTestPrice,
  type TestCourse,
  testCouponCode,
} from './testing/commerce-it';

/*
 * P4-T15 against the integration Postgres + Redis through the real AppModule (real catalog,
 * enrollment and identity facades, the `@udemy/db` operational SQL, every trigger and deferred
 * guard, the outbox). The payment provider is `InMemoryPaymentProvider` (real idempotency
 * semantics and real webhook verification); the HTTP + emulator path is commerce-b.e2e.spec.ts.
 *
 * The reconciler only ever sees THIS file's orders: `ReconcileRepository` is wrapped to filter
 * the real candidate SQL by the file's users, so a shared dev database is never touched.
 */
const CHECKOUT_BASE = 'http://127.0.0.1:9/pay/';

type Get = <T>(token: abstract new (...args: never[]) => T) => T;

/** The real reconcile SQL, restricted to this file's users. */
class OwnRowsReconcileRepository extends ReconcileRepository {
  constructor(
    private readonly inner: KyselyReconcileRepository,
    private readonly users: ReadonlySet<string>,
  ) {
    super();
  }

  tryLock(trx: Parameters<ReconcileRepository['tryLock']>[0]): Promise<boolean> {
    return this.inner.tryLock(trx);
  }

  async findStaleCreating(
    ex: Executor,
    options: { batchSize: number; olderThanMinutes: number },
  ): Promise<StaleCreatingPaymentRecord[]> {
    return (await this.inner.findStaleCreating(ex, options)).filter((r) =>
      this.users.has(r.userId),
    );
  }

  async findOverdueOpen(
    ex: Executor,
    options: { batchSize: number; graceMinutes: number },
  ): Promise<OverdueOpenSessionRecord[]> {
    return (await this.inner.findOverdueOpen(ex, options)).filter((r) => this.users.has(r.userId));
  }
}

/**
 * A provider outage as the API sees it. `@udemy/payments/testing` is an ESM build whose error
 * classes are distinct from the CommonJS main entry the API imports (dual-package), so the
 * fake must throw the main entry's class for `instanceof` to hold, as the real adapter does.
 */
const outage = (): Error =>
  new PaymentProviderUnavailableError({ operation: 'createCheckoutSession' });

async function shiftPaymentTimes(
  db: Kysely<DB>,
  orderId: string,
  options: { createdMinutes: number; expiresMinutes: number },
): Promise<void> {
  // Replica mode: the immutable-column trigger stays out of the way; CHECKs still hold.
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`
      UPDATE commerce.payments
         SET created_at = created_at - make_interval(mins => ${options.createdMinutes}),
             session_expires_at = session_expires_at - make_interval(mins => ${options.expiresMinutes})
       WHERE order_id = ${orderId}
    `.execute(trx);
  });
}

describe('commerce B (integration: checkout, webhook, cancel, reconcile, reads)', () => {
  const pg = useIntegrationDatabase({ max: 8 });
  const itRedis = useIntegrationRedis();
  const userIds: string[] = [];
  const userSet = new Set<string>();
  const courseIds: string[] = [];
  const eventIds: string[] = [];
  const provider = new InMemoryPaymentProvider({ checkoutBaseUrl: CHECKOUT_BASE });
  let app: NestExpressApplication | undefined;
  let owner = '';

  const get: Get = (token) => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const available = (): boolean => pg.available && itRedis.available;
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  async function user(label: string, verified = true): Promise<string> {
    const id = await insertCommerceTestUser(pg.db, label);
    userIds.push(id);
    userSet.add(id);
    if (verified) {
      await pg.db
        .updateTable('identity.users')
        .set({ emailVerifiedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
    }
    return id;
  }

  async function course(price = '19.99', title?: string): Promise<TestCourse> {
    const created = await insertTestCourse(pg.db, { ownerId: owner, title });
    courseIds.push(created.courseId);
    await setTestPrice(pg.db, created.courseId, price, owner);
    return created;
  }

  async function coupon(
    courseId: string | undefined,
    options: Partial<{ percentOff: number; amountOff: string; maxRedemptions: number }> = {},
  ): Promise<string> {
    const code = testCouponCode('B');
    await insertTestCoupon(pg.db, {
      createdBy: owner,
      ...(courseId === undefined ? {} : { courseId }),
      code,
      ...options,
    });
    return code;
  }

  const add = (userId: string, courseId: string) =>
    get(AddToCartCommand).execute({ userId, courseId });
  const apply = (userId: string, code: string) =>
    get(ApplyCouponCommand).execute({ userId, ip: `198.51.100.${userIds.length % 250}`, code });
  const total = async (userId: string): Promise<string> =>
    (await get(GetCartQuery).execute(userId)).totals.totalAmount;
  const checkout = (userId: string, expectedTotal: string, idempotencyKey = randomUUID()) =>
    get(CheckoutCommand).execute({ userId, idempotencyKey, expectedTotal });

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

  const sessionIdOf = (result: CheckoutResult): string => {
    if (result.checkoutUrl === null) throw new Error('no checkout url');
    return result.checkoutUrl.slice(CHECKOUT_BASE.length);
  };

  async function orderRow(orderId: string) {
    return pg.db
      .selectFrom('commerce.orders')
      .select(['status', 'totalAmount', 'paidAt', 'closedAt', 'userId'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
  }

  async function paymentRow(orderId: string) {
    return pg.db
      .selectFrom('commerce.payments')
      .selectAll()
      .where('orderId', '=', orderId)
      .executeTakeFirst();
  }

  async function redemptions(orderId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('commerce.couponRedemptions')
      .select('status')
      .where('orderId', '=', orderId)
      .execute();
    return rows.map((r) => r.status);
  }

  async function outboxTypes(aggregateId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', aggregateId)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    return rows.map((r) => r.type);
  }

  async function activeEnrollments(
    userId: string,
  ): Promise<{ courseId: string; source: string; orderLineId: string | null }[]> {
    return pg.db
      .selectFrom('enrollment.enrollments')
      .select(['courseId', 'source', 'orderLineId'])
      .where('userId', '=', userId)
      .where('status', '=', 'ACTIVE')
      .orderBy('courseId')
      .execute();
  }

  async function transitions(orderId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('commerce.orderTransitions')
      .select(['toStatus', 'cause'])
      .where('orderId', '=', orderId)
      .orderBy('seq')
      .execute();
    return rows.map((r) => `${r.toStatus}:${r.cause}`);
  }

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_PROVIDER)
      .useFactory({ factory: () => provider })
      .overrideProvider(ReconcileRepository)
      .useFactory({
        factory: () => new OwnRowsReconcileRepository(new KyselyReconcileRepository(), userSet),
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    await app.init();
    owner = await user('owner');
  });

  beforeEach(async () => {
    // Every test starts with empty checkout rate-limit buckets (10 / 10 min per user).
    if (!available()) return;
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

  /* ------------------------------------------------------------------ happy path */

  it('checkout -> OPEN session; resume by key -> the same session; completed -> PAID, grants, cart cleanup, events; duplicates are no-ops', async (ctx) => {
    skip(ctx);
    const buyer = await user('happy');
    const a = await course('19.99');
    const b = await course('24.99');
    await add(buyer, a.courseId);
    await add(buyer, b.courseId);
    await apply(buyer, await coupon(b.courseId, { percentOff: 10 }));
    expect(await total(buyer)).toBe('42.48');

    const key = randomUUID();
    const first = await checkout(buyer, '42.48', key);
    expect(first.status).toBe('PENDING_PAYMENT');
    expect(first.checkoutUrl?.startsWith(CHECKOUT_BASE)).toBe(true);
    const sessionId = sessionIdOf(first);
    const creates = provider.calls.filter((c) => c.operation === 'createCheckoutSession');
    expect(creates.at(-1)?.idempotencyKey).toBe(`checkout-session:${first.orderId}`);
    const input = creates.at(-1)?.args[0] as {
      lines: { unitAmountMinor: number }[];
      successUrl: string;
      cancelUrl: string;
    };
    expect(input.lines.map((l) => l.unitAmountMinor)).toEqual([1999, 2249]);
    expect(input.successUrl).toBe(
      `http://localhost:3000/checkout/success?orderId=${first.orderId}`,
    );
    expect(input.cancelUrl).toBe(`http://localhost:3000/checkout/cancel?orderId=${first.orderId}`);

    const again = await checkout(buyer, '42.48', key);
    expect(again).toEqual(first);
    expect(provider.calls.filter((c) => c.operation === 'createCheckoutSession')).toHaveLength(
      creates.length,
    );

    expect(await orderRow(first.orderId)).toMatchObject({
      status: 'PENDING_PAYMENT',
      totalAmount: '42.48',
    });
    expect(await paymentRow(first.orderId)).toMatchObject({
      status: 'OPEN',
      checkoutSessionId: sessionId,
    });
    expect(await redemptions(first.orderId)).toEqual(['RESERVED']);
    expect(await transitions(first.orderId)).toEqual(['PENDING_PAYMENT:CHECKOUT']);

    provider.completeSession(sessionId);
    const completed = provider.checkoutCompletedEvent(sessionId);
    expect(await deliver(completed)).toEqual({ outcome: 'APPLIED', orderId: first.orderId });

    const paid = await orderRow(first.orderId);
    expect(paid.status).toBe('PAID');
    expect(await paymentRow(first.orderId)).toMatchObject({
      status: 'SUCCEEDED',
      checkoutUrl: null,
      receivedAmount: '42.48',
      receivedCurrency: 'USD',
    });
    expect(await redemptions(first.orderId)).toEqual(['CONSUMED']);
    expect(await transitions(first.orderId)).toEqual([
      'PENDING_PAYMENT:CHECKOUT',
      'PAID:PROVIDER_EVENT',
    ]);
    const enrolled = await activeEnrollments(buyer);
    expect(enrolled.map((e) => e.courseId).sort()).toEqual([a.courseId, b.courseId].sort());
    expect(enrolled.every((e) => e.source === 'ORDER' && e.orderLineId !== null)).toBe(true);
    expect((await get(GetCartQuery).execute(buyer)).itemCount).toBe(0);
    const cartRow = await pg.db
      .selectFrom('commerce.carts')
      .select('couponCode')
      .where('userId', '=', buyer)
      .executeTakeFirstOrThrow();
    expect(cartRow.couponCode).toBeNull();

    expect(await outboxTypes(first.orderId)).toEqual(['OrderPlaced.v1', 'OrderPaid.v1']);
    const [paidEvent] = await pg.db
      .selectFrom('outbox.events')
      .select(['payload', 'aggregateType'])
      .where('aggregateId', '=', first.orderId)
      .where('type', '=', 'OrderPaid.v1')
      .execute();
    expect(paidEvent?.aggregateType).toBe(COMMERCE_ORDER_AGGREGATE);
    const payload = OrderPaid.payloadSchema.parse(paidEvent?.payload);
    expect(payload).toMatchObject({
      provider: 'STRIPE',
      totalAmount: '42.48',
      currency: 'USD',
      userId: buyer,
    });
    expect(
      payload.lines.map((l) => [l.finalAmount, l.couponCode !== null, l.revenueShareBps]),
    ).toEqual([
      ['19.99', false, 7000],
      ['22.49', true, 7000],
    ]);

    // Replayed delivery: deduped by event id. A new id for the same effect: DUPLICATE_EFFECT.
    expect(await deliver(completed)).toEqual({ outcome: 'DUPLICATE', orderId: null });
    expect(await deliver({ ...completed, id: `evt_${randomUUID().replace(/-/g, '')}` })).toEqual({
      outcome: 'DUPLICATE_EFFECT',
      orderId: first.orderId,
    });
    // expired after completed: a no-op
    expect(
      await deliver(checkoutSessionExpiredEvent({ sessionId, orderId: first.orderId })),
    ).toEqual({
      outcome: 'IGNORED',
      orderId: first.orderId,
    });
    expect(await outboxTypes(first.orderId)).toEqual(['OrderPlaced.v1', 'OrderPaid.v1']);
    expect(await checkout(buyer, '42.48', key)).toEqual({
      orderId: first.orderId,
      status: 'PAID',
      checkoutUrl: null,
    });
  });

  /* ------------------------------------------------------------------ rejections */

  it('rejects: email_not_verified, cart_empty, price_changed, cart_changed, amount_below_minimum, checkout_in_progress, idempotency_key_reused', async (ctx) => {
    skip(ctx);
    const unverified = await user('unverified', false);
    await expect(checkout(unverified, '0.00')).rejects.toBeInstanceOf(CheckoutEmailNotVerified);

    const buyer = await user('rejects');
    await expect(checkout(buyer, '0.00')).rejects.toBeInstanceOf(CartEmpty);

    const c = await course('29.99');
    await add(buyer, c.courseId);
    const changed = await checkout(buyer, '19.99').catch((e: unknown) => e);
    expect(changed).toBeInstanceOf(PriceChanged);
    expect((changed as PriceChanged).quote.totals.totalAmount).toBe('29.99');

    const archived = await course('19.99');
    await add(buyer, archived.courseId);
    await setTestCourseStatus(pg.db, archived.courseId, 'ARCHIVED');
    const cartChanged = await checkout(buyer, '29.99').catch((e: unknown) => e);
    expect(cartChanged).toBeInstanceOf(CartChanged);
    expect((cartChanged as CartChanged).quote.unavailable.map((u) => u.reason)).toEqual([
      ErrorCode.CourseNotForSale,
    ]);
    await pg.db
      .deleteFrom('commerce.cartItems')
      .where('userId', '=', buyer)
      .where('courseId', '=', archived.courseId)
      .execute();

    const cheap = await user('cheap');
    const tiny = await course('19.99');
    await add(cheap, tiny.courseId);
    await apply(cheap, await coupon(tiny.courseId, { amountOff: '19.60' }));
    await expect(checkout(cheap, '0.39')).rejects.toBeInstanceOf(AmountBelowMinimum);

    const key = randomUUID();
    const placed = await checkout(buyer, '29.99', key);
    const inProgress = await checkout(buyer, '29.99').catch((e: unknown) => e);
    expect(inProgress).toBeInstanceOf(CheckoutInProgress);
    expect(inProgress).toMatchObject({ orderId: placed.orderId, checkoutUrl: placed.checkoutUrl });
    await expect(checkout(buyer, '24.99', key)).rejects.toBeInstanceOf(IdempotencyKeyReused);
  });

  /* ------------------------------------------------------------------ zero total */

  it('zero-total (100% coupon): PAID in one transaction, no provider call, coupon CONSUMED, OrderPaid provider NONE', async (ctx) => {
    skip(ctx);
    const buyer = await user('zero');
    const c = await course('49.99');
    await add(buyer, c.courseId);
    await apply(buyer, await coupon(c.courseId, { percentOff: 100 }));
    const calls = provider.calls.length;
    const result = await checkout(buyer, '0.00');
    expect(result).toMatchObject({ status: 'PAID', checkoutUrl: null });
    expect(provider.calls).toHaveLength(calls);
    expect(await paymentRow(result.orderId)).toBeUndefined();
    expect(await redemptions(result.orderId)).toEqual(['CONSUMED']);
    expect(await transitions(result.orderId)).toEqual(['PAID:ZERO_TOTAL']);
    expect((await activeEnrollments(buyer)).map((e) => e.courseId)).toEqual([c.courseId]);
    expect(await outboxTypes(result.orderId)).toEqual(['OrderPlaced.v1', 'OrderPaid.v1']);
    const receipt = ReceiptSchema.parse(
      await get(GetReceiptQuery).execute({ userId: buyer, orderId: result.orderId }),
    );
    expect(receipt).toMatchObject({
      paymentProvider: 'NONE',
      totalAmount: '0.00',
      subtotalAmount: '49.99',
      discountAmount: '49.99',
    });
  });

  /* ------------------------------------------------------------------ provider outage */

  it('provider outage: 503 payment_provider_unavailable, the order stays CREATING, the same key resumes it', async (ctx) => {
    skip(ctx);
    const buyer = await user('outage');
    const c = await course('19.99');
    await add(buyer, c.courseId);
    const key = randomUUID();
    provider.failNext('createCheckoutSession', outage());
    await expect(checkout(buyer, '19.99', key)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    const order = await pg.db
      .selectFrom('commerce.orders')
      .select('id')
      .where('userId', '=', buyer)
      .executeTakeFirstOrThrow();
    expect(await paymentRow(order.id)).toMatchObject({
      status: 'CREATING',
      checkoutSessionId: null,
    });
    const resumed = await checkout(buyer, '19.99', key);
    expect(resumed).toMatchObject({ orderId: order.id, status: 'PENDING_PAYMENT' });
    expect(await paymentRow(order.id)).toMatchObject({ status: 'OPEN' });
    const keys = provider.calls
      .filter(
        (c2) =>
          c2.operation === 'createCheckoutSession' &&
          (c2.args[0] as { orderId: string }).orderId === order.id,
      )
      .map((c2) => c2.idempotencyKey);
    expect(keys).toEqual([`checkout-session:${order.id}`, `checkout-session:${order.id}`]);
  });

  /* ------------------------------------------------------------------ concurrency */

  it('races: the same key twice in parallel places one order; two keys in parallel: one order, one checkout_in_progress', async (ctx) => {
    skip(ctx);
    const buyer = await user('race-key');
    const c = await course('19.99');
    await add(buyer, c.courseId);
    const key = randomUUID();
    const [x, y] = await Promise.all([
      checkout(buyer, '19.99', key),
      checkout(buyer, '19.99', key),
    ]);
    expect(x.orderId).toBe(y.orderId);
    expect(
      await pg.db.selectFrom('commerce.orders').select('id').where('userId', '=', buyer).execute(),
    ).toHaveLength(1);

    const other = await user('race-keys');
    await add(other, c.courseId);
    const settled = await Promise.allSettled([checkout(other, '19.99'), checkout(other, '19.99')]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(CheckoutInProgress);
  });

  it('max_redemptions=1 under parallel checkouts by 5 buyers: exactly one reservation, the others price_changed', async (ctx) => {
    skip(ctx);
    const c = await course('59.99');
    const code = await coupon(c.courseId, { percentOff: 50, maxRedemptions: 1 });
    const buyers = await Promise.all([1, 2, 3, 4, 5].map((n) => user(`burst-${n}`)));
    for (const b of buyers) {
      await add(b, c.courseId);
      await apply(b, code);
    }
    const expected = await total(buyers[0] ?? '');
    expect(expected).toBe('29.99'); // 50% of 59.99 rounds the discount half-up to 30.00
    const settled = await Promise.allSettled(buyers.map((b) => checkout(b, expected)));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled) {
      if (s.status === 'rejected') {
        expect(s.reason).toBeInstanceOf(PriceChanged);
        expect((s.reason as PriceChanged).quote.totals.totalAmount).toBe('59.99');
      }
    }
    const reserved = await pg.db
      .selectFrom('commerce.couponRedemptions as r')
      .innerJoin('commerce.coupons as c', 'c.id', 'r.couponId')
      .select('r.status')
      .where('c.code', '=', code)
      .execute();
    expect(reserved.map((r) => r.status)).toEqual(['RESERVED']);
  });

  /* ------------------------------------------------------------------ webhook edge cases */

  it('amount mismatch: PAYMENT_REVIEW, OrderPaymentMismatch, no enrollment', async (ctx) => {
    skip(ctx);
    const buyer = await user('mismatch');
    const c = await course('19.99');
    await add(buyer, c.courseId);
    const placed = await checkout(buyer, '19.99');
    const sessionId = sessionIdOf(placed);
    const result = await deliver(
      checkoutSessionCompletedEvent({ sessionId, orderId: placed.orderId, amountTotalMinor: 100 }),
    );
    expect(result).toEqual({ outcome: 'MISMATCH', orderId: placed.orderId });
    expect((await orderRow(placed.orderId)).status).toBe('PAYMENT_REVIEW');
    expect(await paymentRow(placed.orderId)).toMatchObject({
      status: 'SUCCEEDED',
      receivedAmount: '1.00',
    });
    expect(await activeEnrollments(buyer)).toEqual([]);
    expect(await outboxTypes(placed.orderId)).toEqual([
      'OrderPlaced.v1',
      'OrderPaymentMismatch.v1',
    ]);
    await expect(
      get(GetReceiptQuery).execute({ userId: buyer, orderId: placed.orderId }),
    ).rejects.toBeInstanceOf(OrderNotPaid);
  });

  it('expired, then a late completed: EXPIRED (coupon RELEASED, OrderExpired), then PAID (coupon re-consumed)', async (ctx) => {
    skip(ctx);
    const buyer = await user('late');
    const c = await course('39.99');
    await add(buyer, c.courseId);
    await apply(buyer, await coupon(c.courseId, { percentOff: 25 }));
    const placed = await checkout(buyer, '29.99');
    const sessionId = sessionIdOf(placed);
    provider.expireSessionNow(sessionId);
    expect(await deliver(provider.checkoutExpiredEvent(sessionId))).toEqual({
      outcome: 'APPLIED',
      orderId: placed.orderId,
    });
    expect((await orderRow(placed.orderId)).status).toBe('EXPIRED');
    expect(await paymentRow(placed.orderId)).toMatchObject({
      status: 'EXPIRED',
      checkoutUrl: null,
    });
    expect(await redemptions(placed.orderId)).toEqual(['RELEASED']);
    expect(await outboxTypes(placed.orderId)).toEqual(['OrderPlaced.v1', 'OrderExpired.v1']);
    // the open-checkout slot is free again
    expect(
      await get(CheckoutCommand)
        .execute({ userId: buyer, idempotencyKey: randomUUID(), expectedTotal: '29.99' })
        .then(async (r) => {
          await get(CancelPendingOrderCommand).execute({ userId: buyer, orderId: r.orderId });
          return r.status;
        }),
    ).toBe('PENDING_PAYMENT');

    const late = await deliver(
      checkoutSessionCompletedEvent({ sessionId, orderId: placed.orderId, amountTotalMinor: 2999 }),
    );
    expect(late).toEqual({ outcome: 'APPLIED', orderId: placed.orderId });
    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('PAID');
    expect(row.closedAt).not.toBeNull();
    expect(await redemptions(placed.orderId)).toEqual(['CONSUMED']);
    expect(await transitions(placed.orderId)).toEqual([
      'PENDING_PAYMENT:CHECKOUT',
      'EXPIRED:PROVIDER_EVENT',
      'PAID:PROVIDER_EVENT',
    ]);
  });

  it('D15: paying for a course that is already active creates a SYSTEM DUPLICATE_PURCHASE refund (APPROVED, RefundApproved)', async (ctx) => {
    skip(ctx);
    const buyer = await user('duplicate');
    const c = await course('19.99');
    await add(buyer, c.courseId);
    const placed = await checkout(buyer, '19.99');
    await insertTestEnrollment(pg.db, buyer, c.courseId);
    const sessionId = sessionIdOf(placed);
    provider.completeSession(sessionId);
    expect(await deliver(provider.checkoutCompletedEvent(sessionId))).toMatchObject({
      outcome: 'APPLIED',
    });
    const refunds = await pg.db
      .selectFrom('commerce.refunds')
      .select(['status', 'initiatedBy', 'reasonCode', 'amount'])
      .where('orderId', '=', placed.orderId)
      .execute();
    expect(refunds).toEqual([
      {
        status: 'APPROVED',
        initiatedBy: 'SYSTEM',
        reasonCode: 'DUPLICATE_PURCHASE',
        amount: '19.99',
      },
    ]);
    expect(await outboxTypes(placed.orderId)).toEqual([
      'OrderPlaced.v1',
      'RefundApproved.v1',
      'OrderPaid.v1',
    ]);
    const detail = await get(GetMyOrderQuery).execute({ userId: buyer, orderId: placed.orderId });
    expect(detail.lines[0]?.refund).toMatchObject({
      status: 'APPROVED',
      eligible: false,
      reason: ErrorCode.RefundAlreadyRequested,
    });
  });

  it('dispute -> PaymentDisputed; a foreign refund event is ORPHAN; livemode, unknown sessions and unhandled types are recorded too', async (ctx) => {
    skip(ctx);
    const buyer = await user('dispute');
    const c = await course('19.99');
    await add(buyer, c.courseId);
    const placed = await checkout(buyer, '19.99');
    const sessionId = sessionIdOf(placed);
    const done = provider.completeSession(sessionId);
    await deliver(provider.checkoutCompletedEvent(sessionId));
    expect(
      await deliver(chargeDisputeCreatedEvent({ paymentIntentId: done.paymentIntentId })),
    ).toEqual({ outcome: 'APPLIED', orderId: placed.orderId });
    expect(await outboxTypes(placed.orderId)).toContain('PaymentDisputed.v1');

    // P4-T16: a refund of this payment that is not ours (e.g. made in the dashboard) is ORPHAN.
    expect(
      await deliver(
        refundUpdatedEvent({ refundId: randomUUID(), paymentIntentId: done.paymentIntentId }),
      ),
    ).toEqual({ outcome: 'ORPHAN', orderId: placed.orderId });
    expect(
      await deliver(checkoutSessionCompletedEvent({ orderId: null, clientReferenceId: null })),
    ).toEqual({ outcome: 'ORPHAN', orderId: null });
    expect(
      await deliver(
        checkoutSessionCompletedEvent({ sessionId, orderId: placed.orderId }, { livemode: true }),
      ),
    ).toEqual({ outcome: 'IGNORED', orderId: null });
    expect(
      await deliver(stripeEvent('checkout.session.async_payment_succeeded', { id: sessionId })),
    ).toEqual({ outcome: 'IGNORED', orderId: null });
    const outcomes = await pg.db
      .selectFrom('commerce.providerEvents')
      .select(['eventId', 'outcome', 'processedAt'])
      .where('eventId', 'in', eventIds.slice(-6))
      .execute();
    expect(outcomes).toHaveLength(6);
    expect(outcomes.every((o) => o.processedAt !== null)).toBe(true);
  });

  /* ------------------------------------------------------------------ cancel */

  it('cancel: OPEN -> CANCELED (session expired, coupon RELEASED), a repeat is a 200; a completed session is 409; foreign orders are 404', async (ctx) => {
    skip(ctx);
    const buyer = await user('cancel');
    const c = await course('24.99');
    await add(buyer, c.courseId);
    const code = await coupon(c.courseId, { percentOff: 20 });
    await apply(buyer, code);
    const placed = await checkout(buyer, '19.99');
    const sessionId = sessionIdOf(placed);
    const stranger = await user('stranger');
    await expect(
      get(CancelPendingOrderCommand).execute({ userId: stranger, orderId: placed.orderId }),
    ).rejects.toBeInstanceOf(OrderNotFound);

    const canceled = OrderDetailSchema.parse(
      await get(CancelPendingOrderCommand).execute({ userId: buyer, orderId: placed.orderId }),
    );
    expect(canceled).toMatchObject({
      status: 'CANCELED',
      checkoutUrl: null,
      payment: { provider: 'STRIPE', status: 'EXPIRED' },
    });
    expect(provider.session(sessionId)?.status).toBe('expired');
    expect(await redemptions(placed.orderId)).toEqual(['RELEASED']);
    expect(await outboxTypes(placed.orderId)).toEqual(['OrderPlaced.v1', 'OrderCanceled.v1']);
    expect(
      (await get(CancelPendingOrderCommand).execute({ userId: buyer, orderId: placed.orderId }))
        .status,
    ).toBe('CANCELED');

    // the coupon is usable again, and a completed-but-not-yet-delivered session cannot be canceled
    const second = await checkout(buyer, '19.99');
    provider.completeSession(sessionIdOf(second));
    await expect(
      get(CancelPendingOrderCommand).execute({ userId: buyer, orderId: second.orderId }),
    ).rejects.toBeInstanceOf(OrderNotCancelable);
    expect((await orderRow(second.orderId)).status).toBe('PENDING_PAYMENT');
    await deliver(provider.checkoutCompletedEvent(sessionIdOf(second)));
    await expect(
      get(CancelPendingOrderCommand).execute({ userId: buyer, orderId: second.orderId }),
    ).rejects.toBeInstanceOf(OrderNotCancelable);
  });

  /* ------------------------------------------------------------------ reconcile */

  it('reconcile: (a) stale CREATING -> replay + expire -> ABANDONED / CANCELED; (b) overdue OPEN paid -> PAID, still open -> EXPIRED', async (ctx) => {
    skip(ctx);
    const c = await course('19.99');
    const staleBuyer = await user('stale');
    await add(staleBuyer, c.courseId);
    provider.failNext('createCheckoutSession', outage());
    await expect(checkout(staleBuyer, '19.99')).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    const stale = await pg.db
      .selectFrom('commerce.orders')
      .select('id')
      .where('userId', '=', staleBuyer)
      .executeTakeFirstOrThrow();
    await shiftPaymentTimes(pg.db, stale.id, { createdMinutes: 16, expiresMinutes: 0 });

    const paidBuyer = await user('overdue-paid');
    await add(paidBuyer, c.courseId);
    const paid = await checkout(paidBuyer, '19.99');
    provider.completeSession(sessionIdOf(paid)); // the webhook never arrives
    await shiftPaymentTimes(pg.db, paid.orderId, { createdMinutes: 60, expiresMinutes: 60 });

    const openBuyer = await user('overdue-open');
    await add(openBuyer, c.courseId);
    const open = await checkout(openBuyer, '19.99');
    await shiftPaymentTimes(pg.db, open.orderId, { createdMinutes: 60, expiresMinutes: 60 });

    const report = await get(CommerceJobs).reconcile();
    expect(report).toEqual({ locked: true, abandoned: 1, completed: 1, expired: 1, skipped: 0 });

    expect((await orderRow(stale.id)).status).toBe('CANCELED');
    expect(await paymentRow(stale.id)).toMatchObject({ status: 'ABANDONED' });
    expect(await transitions(stale.id)).toEqual([
      'PENDING_PAYMENT:CHECKOUT',
      'CANCELED:RECONCILER',
    ]);

    expect((await orderRow(paid.orderId)).status).toBe('PAID');
    expect(await transitions(paid.orderId)).toEqual([
      'PENDING_PAYMENT:CHECKOUT',
      'PAID:RECONCILER',
    ]);
    const synthetic = await pg.db
      .selectFrom('commerce.providerEvents')
      .select(['eventId', 'outcome'])
      .where('orderId', '=', paid.orderId)
      .execute();
    expect(synthetic).toEqual([
      { eventId: `reconcile:${sessionIdOf(paid)}:COMPLETED`, outcome: 'APPLIED' },
    ]);
    expect((await activeEnrollments(paidBuyer)).map((e) => e.courseId)).toEqual([c.courseId]);

    expect((await orderRow(open.orderId)).status).toBe('EXPIRED');
    expect(provider.session(sessionIdOf(open))?.status).toBe('expired');

    // A late real webhook for the reconciled payment is a DUPLICATE_EFFECT; a second run is idle.
    expect(await deliver(provider.checkoutCompletedEvent(sessionIdOf(paid)))).toMatchObject({
      outcome: 'DUPLICATE_EFFECT',
    });
    expect(await get(CommerceJobs).reconcile()).toEqual({
      locked: true,
      abandoned: 0,
      completed: 0,
      expired: 0,
      skipped: 0,
    });
  });

  /* ------------------------------------------------------------------ reads */

  it('reads: my orders (keyset, newest first), detail (slug, refund state, payment), receipt; foreign orders are 404', async (ctx) => {
    skip(ctx);
    const buyer = await user('reads');
    const courses = [
      await course('19.99', 'Reads course one'),
      await course('24.99', 'Reads course two'),
      await course('29.99', 'Reads course three'),
    ];
    const orderIds: string[] = [];
    for (const c of courses) {
      await add(buyer, c.courseId);
      const placed = await checkout(buyer, await total(buyer));
      provider.completeSession(sessionIdOf(placed));
      await deliver(provider.checkoutCompletedEvent(sessionIdOf(placed)));
      orderIds.push(placed.orderId);
    }
    const page1 = OrderSummaryPageSchema.parse(
      await get(ListMyOrdersQuery).execute({ userId: buyer, limit: 2 }),
    );
    expect(page1.items.map((i) => i.id)).toEqual([orderIds[2], orderIds[1]]);
    expect(page1.items[0]).toMatchObject({
      status: 'PAID',
      lineCount: 1,
      courseTitles: ['Reads course three'],
    });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await get(ListMyOrdersQuery).execute({
      userId: buyer,
      limit: 2,
      cursor: page1.nextCursor ?? '',
    });
    expect(page2.items.map((i) => i.id)).toEqual([orderIds[0]]);
    expect(page2.nextCursor).toBeNull();

    const detail = OrderDetailSchema.parse(
      await get(GetMyOrderQuery).execute({ userId: buyer, orderId: orderIds[0] ?? '' }),
    );
    expect(detail).toMatchObject({
      status: 'PAID',
      subtotalAmount: '19.99',
      totalAmount: '19.99',
      refundedAmount: '0.00',
      payment: { provider: 'STRIPE', status: 'SUCCEEDED' },
      checkoutUrl: null,
    });
    expect(detail.lines[0]).toMatchObject({
      courseId: courses[0]?.courseId,
      slug: courses[0]?.slug,
      courseTitle: 'Reads course one',
      refund: { eligible: true, reason: null, refundId: null },
    });
    expect(detail.lines[0]?.instructor?.id).toBe(owner);
    const receipt = ReceiptSchema.parse(
      await get(GetReceiptQuery).execute({ userId: buyer, orderId: orderIds[0] ?? '' }),
    );
    expect(receipt).toMatchObject({
      paymentProvider: 'STRIPE',
      totalAmount: '19.99',
      buyer: { displayName: expect.stringContaining('Commerce IT') },
    });

    const stranger = await user('reads-stranger');
    await expect(
      get(GetMyOrderQuery).execute({ userId: stranger, orderId: orderIds[0] ?? '' }),
    ).rejects.toBeInstanceOf(OrderNotFound);
    await expect(
      get(GetReceiptQuery).execute({ userId: stranger, orderId: orderIds[0] ?? '' }),
    ).rejects.toBeInstanceOf(OrderNotFound);
    expect((await get(ListMyOrdersQuery).execute({ userId: stranger, limit: 20 })).items).toEqual(
      [],
    );
  });
});
