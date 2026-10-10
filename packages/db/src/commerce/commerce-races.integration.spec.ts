import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantEnrollment } from '../enrollment/enrollments';
import { createUser } from '../testing/fixtures';
import {
  createCoupon,
  createOrder,
  createRefund,
  openPayment,
  payOrder,
  testEventId,
} from '../testing/commerce-fixtures';
import {
  backendPid,
  deleteTestData,
  type PgErrorShape,
  signal,
  useIntegrationDb,
  waitUntilBlocked,
} from '../testing/it-db.mjs';
import { claimProviderEvent } from './provider-events';

/**
 * Two-connection races of docs/phase-4-schema-design.md §6 (R1, R3, R4, R6) and the hand-off
 * concurrency list. Two connections can't see each other's uncommitted rows, so these tests
 * commit; every row belongs to users created here and is removed in afterAll (replica-role
 * cleanup: the append-only tables can't be deleted otherwise). Blocking is proven structurally
 * (pg_stat_activity wait_event_type = 'Lock'), never by timing.
 */
const PARALLEL = 20;
const pg = useIntegrationDb({ max: PARALLEL + 4 });
const users: string[] = [];
const eventIds: string[] = [];

async function user(): Promise<string> {
  const id = await createUser(pg.db);
  users.push(id);
  return id;
}

let instructor: string;

beforeAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  instructor = await user();
});

afterAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  await deleteTestData(pg.db, users, [], { providerEventIds: eventIds });
});

function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: PgErrorShape & Error }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as PgErrorShape & Error }),
  );
}

describe('R1: coupon reservations against max_redemptions', () => {
  it(`${PARALLEL} parallel checkouts against max_redemptions = 1 reserve exactly once`, async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const coupon = await createCoupon(pg.db, {
      createdBy: instructor,
      percentOff: 20,
      maxRedemptions: 1,
    });
    users.push(...(await Promise.all(Array.from({ length: PARALLEL }, () => createUser(pg.db)))));
    const buyers = users.slice(-PARALLEL);
    const results = await Promise.all(
      buyers.map((buyer) =>
        settle(
          pg.db.transaction().execute((trx) =>
            createOrder(trx, {
              userId: buyer,
              lines: [{ instructorId: instructor, listAmount: '25.00', couponId: coupon }],
            }),
          ),
        ),
      ),
    );
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    for (const r of lost) {
      expect(r.ok === false && { code: r.error.code, constraint: r.error.constraint }).toEqual({
        code: '23514',
        constraint: 'coupon_redemptions_limit_ck',
      });
    }
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM commerce.coupon_redemptions WHERE coupon_id = ${coupon} AND status IN ('RESERVED','CONSUMED')
    `.execute(pg.db);
    expect(rows[0]!.n).toBe(1);
  });

  it('a deactivation racing a reservation: the reservation waits for the coupon lock, then fails coupon_valid_ck', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const coupon = await createCoupon(pg.db, { createdBy: instructor, percentOff: 20 });
    const buyer = await user();
    const deactivated = signal();
    const reserveBlocked = signal();
    const deactivate = pg.db.transaction().execute(async (trx) => {
      await sql`UPDATE commerce.coupons SET deactivated_at = now(), deactivated_by = ${instructor} WHERE id = ${coupon} AND deactivated_at IS NULL`.execute(
        trx,
      );
      deactivated.resolve();
      await reserveBlocked.promise;
    });
    await deactivated.promise;
    const reserve = settle(
      pg.db.transaction().execute(async (trx) => {
        const pid = await backendPid(trx);
        const p = createOrder(trx, {
          userId: buyer,
          lines: [{ instructorId: instructor, listAmount: '25.00', couponId: coupon }],
        });
        await waitUntilBlocked(pg.db, pid); // FOR NO KEY UPDATE in coupon_redemptions_reserve_trg
        reserveBlocked.resolve();
        return p;
      }),
    );
    await deactivate;
    const r = await reserve;
    expect(r.ok === false && { code: r.error.code, constraint: r.error.constraint }).toEqual({
      code: '23514',
      constraint: 'coupon_redemptions_coupon_valid_ck',
    });
  });

  it('a reservation holding the coupon lock makes the deactivation wait; both then commit in that order', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const coupon = await createCoupon(pg.db, { createdBy: instructor, percentOff: 20 });
    const buyer = await user();
    const reserved = signal();
    const deactivateBlocked = signal();
    const reserve = pg.db.transaction().execute(async (trx) => {
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00', couponId: coupon }],
      });
      reserved.resolve();
      await deactivateBlocked.promise;
      return order;
    });
    await reserved.promise;
    const deactivate = pg.db.transaction().execute(async (trx) => {
      const pid = await backendPid(trx);
      const p =
        sql`UPDATE commerce.coupons SET deactivated_at = now(), deactivated_by = ${instructor} WHERE id = ${coupon} AND deactivated_at IS NULL`.execute(
          trx,
        );
      await waitUntilBlocked(pg.db, pid);
      deactivateBlocked.resolve();
      return p;
    });
    const order = await reserve;
    expect(Number((await deactivate).numAffectedRows)).toBe(1);
    // the existing reservation is honoured (price locked at checkout); it can still be paid
    expect(await payOrder(pg.db, order).then((r) => (eventIds.push(r.eventId), r.outcome))).toBe(
      'APPLIED',
    );
  });
});

describe('R2/R4: concurrent PAID transitions of one order', () => {
  it('two webhook deliveries (different event ids) -> exactly one APPLIED, the other DUPLICATE_EFFECT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const buyer = await user();
    const order = await createOrder(pg.db, {
      userId: buyer,
      lines: [{ instructorId: instructor, listAmount: '25.00' }],
    });
    await openPayment(pg.db, order.orderId);
    const firstPaid = signal();
    const secondBlocked = signal();
    const first = pg.db.transaction().execute(async (trx) => {
      const r = await payOrder(trx, order);
      eventIds.push(r.eventId);
      firstPaid.resolve();
      await secondBlocked.promise;
      return r;
    });
    await firstPaid.promise;
    const second = pg.db.transaction().execute(async (trx) => {
      const pid = await backendPid(trx);
      const p = payOrder(trx, order).then((r) => (eventIds.push(r.eventId), r));
      await waitUntilBlocked(pg.db, pid); // cart row lock (lock step 1)
      secondBlocked.resolve();
      return p;
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.outcome).toBe('APPLIED');
    expect(b).toMatchObject({ outcome: 'DUPLICATE_EFFECT', status: 'PAID' });
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM commerce.order_transitions WHERE order_id = ${order.orderId} AND to_status = 'PAID'
    `.execute(pg.db);
    expect(rows[0]!.n).toBe(1);
  });

  it('concurrent grants of one (user, course) serialise on the upsert: one GRANTED, one ALREADY_ACTIVE', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const buyer = await user();
    const course = crypto.randomUUID();
    const granted = signal();
    const secondBlocked = signal();
    const first = pg.db.transaction().execute(async (trx) => {
      const r = await grantEnrollment(trx, { userId: buyer, courseId: course, source: 'FREE' });
      granted.resolve();
      await secondBlocked.promise;
      return r;
    });
    await granted.promise;
    const second = pg.db.transaction().execute(async (trx) => {
      const pid = await backendPid(trx);
      const p = grantEnrollment(trx, { userId: buyer, courseId: course, source: 'FREE' });
      await waitUntilBlocked(pg.db, pid);
      secondBlocked.resolve();
      return p;
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.outcome).toBe('GRANTED');
    expect(b).toEqual({ outcome: 'ALREADY_ACTIVE', enrollmentId: a.enrollmentId });
  });
});

describe('R3: refund vs the PAID transition', () => {
  async function pendingOrder() {
    const buyer = await user();
    const order = await createOrder(pg.db, {
      userId: buyer,
      lines: [{ instructorId: instructor, listAmount: '25.00' }],
    });
    await openPayment(pg.db, order.orderId);
    return order;
  }

  async function race(order: Awaited<ReturnType<typeof pendingOrder>>, commitPaid: boolean) {
    const paid = signal();
    const refundBlocked = signal();
    const pay = settle(
      pg.db.transaction().execute(async (trx) => {
        const r = await payOrder(trx, order);
        eventIds.push(r.eventId);
        paid.resolve();
        await refundBlocked.promise;
        if (!commitPaid) throw new Error('roll the PAID transition back');
        return r;
      }),
    );
    await paid.promise;
    const line = order.lines[0]!;
    const refund = settle(
      pg.db.transaction().execute(async (trx) => {
        const pid = await backendPid(trx);
        const p = createRefund(trx, {
          orderId: order.orderId,
          orderLineId: line.id,
          userId: order.userId,
          amount: line.finalAmount,
        });
        await waitUntilBlocked(pg.db, pid); // refunds_insert_guard: FOR SHARE on the order row
        refundBlocked.resolve();
        return p;
      }),
    );
    return { pay: await pay, refund: await refund };
  }

  it('a refund insert waits for the in-flight PAID transition and succeeds once it commits', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const { pay, refund } = await race(await pendingOrder(), true);
    expect(pay.ok && pay.value.outcome).toBe('APPLIED');
    expect(refund.ok).toBe(true);
  });

  it('... and fails refunds_order_status_ck when the PAID transition rolls back', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const { pay, refund } = await race(await pendingOrder(), false);
    expect(pay.ok).toBe(false);
    expect(
      refund.ok === false && { code: refund.error.code, constraint: refund.error.constraint },
    ).toEqual({
      code: '23514',
      constraint: 'refunds_order_status_ck',
    });
  });

  it('two refund requests for one line from two connections: the second fails refunds_order_line_id_live_uq', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const order = await pendingOrder();
    eventIds.push((await payOrder(pg.db, order)).eventId);
    const line = order.lines[0]!;
    const spec = {
      orderId: order.orderId,
      orderLineId: line.id,
      userId: order.userId,
      amount: line.finalAmount,
    };
    const inserted = signal();
    const secondBlocked = signal();
    const first = pg.db.transaction().execute(async (trx) => {
      await createRefund(trx, spec);
      inserted.resolve();
      await secondBlocked.promise;
    });
    await inserted.promise;
    const second = settle(
      pg.db.transaction().execute(async (trx) => {
        const pid = await backendPid(trx);
        const p = createRefund(trx, spec);
        await waitUntilBlocked(pg.db, pid); // unique index insert waits for the first transaction
        secondBlocked.resolve();
        return p;
      }),
    );
    await first;
    const r = await second;
    expect(r.ok === false && { code: r.error.code, constraint: r.error.constraint }).toEqual({
      code: '23505',
      constraint: 'refunds_order_line_id_live_uq',
    });
  });
});

describe('R6: duplicate webhook delivery', () => {
  const claim = (eventId: string) => ({
    eventId,
    type: 'checkout.session.completed',
    livemode: false,
    objectId: 'cs_race',
    providerCreatedAt: new Date(),
    payloadSha256: createHash('sha256').update(eventId).digest(),
  });

  for (const firstCommits of [true, false]) {
    it(`the second claim blocks on provider_events_pk and gets ${firstCommits ? 'false (duplicate)' : 'true (first rolled back)'}`, async (ctx) => {
      pg.skipIfUnavailable(ctx);
      const evt = testEventId();
      eventIds.push(evt);
      const claimed = signal();
      const secondBlocked = signal();
      const first = settle(
        pg.db.transaction().execute(async (trx) => {
          expect(await claimProviderEvent(trx, claim(evt))).toBe(true);
          claimed.resolve();
          await secondBlocked.promise;
          if (!firstCommits) throw new Error('handler failed: 500');
        }),
      );
      await claimed.promise;
      const second = pg.db.transaction().execute(async (trx) => {
        const pid = await backendPid(trx);
        const p = claimProviderEvent(trx, claim(evt));
        await waitUntilBlocked(pg.db, pid);
        secondBlocked.resolve();
        return p;
      });
      expect((await first).ok).toBe(firstCommits);
      expect(await second).toBe(!firstCommits);
    });
  }
});
