import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../generated/db';
import { MAX_BATCH_SIZE } from '../internal/assert';
import { createUser } from '../testing/fixtures';
import {
  createCoupon,
  createOrder,
  createRefund,
  openPayment,
  payOrder,
  setCoursePrice,
} from '../testing/commerce-fixtures';
import { checkDeferredNow, rollback, signal, useIntegrationDb } from '../testing/it-db.mjs';
import { releaseCouponRedemptions } from './coupons';
import { lockUserCart } from './locks';
import { appendOrderTransition } from './orders';
import { lockCheckoutCoupons, quoteCart } from './quote';
import { findOverdueOpenSessions, findStaleCreatingPayments } from './reconcile';
import {
  applySucceededRefundsToOrder,
  completeRefundDispatch,
  failRefundDispatch,
  leaseRefundsForDispatch,
  releaseRefundDispatchLease,
} from './refunds';
import { getInstructorSalesSummary, listRecentSales } from './sales';

/**
 * Phase 4 operational SQL (docs/phase-4-schema-design.md §8) against the real schema. Global
 * statements (dispatch lease, reconcile scans) run only in rolled-back transactions, so they can
 * never stamp or touch another suite's rows on a shared dev database; assertions look only at
 * this test's rows. Every transaction passes the deferred checks (`checkDeferredNow`), i.e. the
 * functions leave the database COMMIT-consistent.
 */
const pg = useIntegrationDb({ max: 4 });
type Trx = Transaction<DB>;

async function paidOrder(trx: Trx, amounts: string[], instructor?: string) {
  const buyer = await createUser(trx);
  const inst = instructor ?? (await createUser(trx));
  const order = await createOrder(trx, {
    userId: buyer,
    lines: amounts.map((listAmount) => ({ instructorId: inst, listAmount })),
  });
  await openPayment(trx, order.orderId);
  const paid = await payOrder(trx, order);
  expect(paid.outcome).toBe('APPLIED');
  return { ...order, instructor: inst };
}

describe('quoteCart', () => {
  it('prices lines, picks the best coupon (tie -> course coupon), skips free lines and explains candidates', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const buyer = await createUser(trx);
      const instructor = await createUser(trx);
      const [c1, c2, free, unpriced] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await setCoursePrice(trx, { courseId: c1, amount: '20.00', updatedBy: instructor });
      await setCoursePrice(trx, { courseId: c2, amount: '49.99', updatedBy: instructor });
      await setCoursePrice(trx, { courseId: free, amount: '0', updatedBy: instructor });
      const code = 'SAVE10NOW';
      const courseCoupon = await createCoupon(trx, {
        createdBy: instructor,
        courseId: c1,
        code,
        amountOff: '2.00',
      }); // 2.00 off 20.00
      const platform = await createCoupon(trx, { createdBy: instructor, code, percentOff: 10 }); // 2.00 / 5.00
      await createCoupon(trx, {
        createdBy: instructor,
        courseId: randomUUID(),
        code,
        percentOff: 90,
      }); // other course: not a candidate
      await lockUserCart(trx, buyer);
      await sql`UPDATE commerce.carts SET coupon_code = ${code} WHERE user_id = ${buyer}`.execute(
        trx,
      );
      for (const [i, course] of [c1, c2, free, unpriced].entries()) {
        await sql`
          INSERT INTO commerce.cart_items (user_id, course_id, added_at) VALUES (${buyer}, ${course}, now() + make_interval(secs => ${i}))
        `.execute(trx);
      }
      const quote = await quoteCart(trx, buyer);
      expect(
        quote.lines.map((l) => [
          l.courseId,
          l.listAmount,
          l.couponId,
          l.discountAmount,
          l.finalAmount,
        ]),
      ).toEqual([
        [c1, '20.00', courseCoupon, '2.00', '18.00'], // tie 2.00 vs 2.00 -> course coupon
        [c2, '49.99', platform, '5.00', '44.99'],
        [free, '0.00', null, '0.00', '0.00'],
        [unpriced, null, null, '0.00', null],
      ]);
      expect(quote.candidates.map((c) => [c.id, c.state, c.usedCount, c.usedByMe]).sort()).toEqual(
        [
          [courseCoupon, 'ACTIVE', '0', false],
          [platform, 'ACTIVE', '0', false],
        ].sort(),
      );
      expect((await lockCheckoutCoupons(trx, code, [c1, c2])).sort()).toEqual(
        [courseCoupon, platform].sort(),
      );

      // used by me -> excluded from the best pick, explained by the candidate
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [
          { instructorId: instructor, listAmount: '20.00', courseId: c1, couponId: platform },
        ],
      });
      const again = await quoteCart(trx, buyer);
      expect(again.lines[1]).toMatchObject({
        courseId: c2,
        couponId: null,
        discountAmount: '0.00',
      });
      expect(again.candidates.find((c) => c.id === platform)).toMatchObject({
        usedByMe: true,
        usedCount: '1',
      });
      expect(order.status).toBe('PENDING_PAYMENT');
    });
  });
});

describe('markOrderPaid', () => {
  it('APPLIED from PENDING: payment SUCCEEDED, paid_at, transition, redemptions CONSUMED; COMMIT-consistent', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const buyer = await createUser(trx);
      const instructor = await createUser(trx);
      const coupon = await createCoupon(trx, { createdBy: instructor, percentOff: 10 });
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [
          { instructorId: instructor, listAmount: '30.00', couponId: coupon },
          { instructorId: instructor, listAmount: '20.00' },
        ],
      });
      await openPayment(trx, order.orderId);
      const r = await payOrder(trx, order);
      expect(r).toMatchObject({
        outcome: 'APPLIED',
        userId: buyer,
        previousStatus: 'PENDING_PAYMENT',
        consumedCoupons: 1,
      });
      if (r.outcome !== 'APPLIED') throw new Error('unreachable');
      expect(r.lines.map((l) => l.courseId)).toEqual([...r.lines.map((l) => l.courseId)].sort());
      expect(r.lines.map((l) => l.finalAmount).sort()).toEqual(['20.00', '27.00']);
      await checkDeferredNow(trx);
      expect(await payOrder(trx, order)).toMatchObject({
        outcome: 'DUPLICATE_EFFECT',
        status: 'PAID',
      });
      const pay = await sql<{ status: string; checkoutUrl: string | null; receivedAmount: string }>`
        SELECT status, checkout_url, received_amount FROM commerce.payments WHERE order_id = ${order.orderId}
      `.execute(trx);
      expect(pay.rows[0]).toEqual({
        status: 'SUCCEEDED',
        checkoutUrl: null,
        receivedAmount: '47.00',
      });
    });
  });

  it('a late payment of an EXPIRED order is APPLIED (RELEASED -> CONSUMED); a mismatch goes to PAYMENT_REVIEW', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const instructor = await createUser(trx);
      const coupon = await createCoupon(trx, { createdBy: instructor, percentOff: 10 });
      const expire = async (orderId: string) => {
        await sql`UPDATE commerce.payments SET status = 'EXPIRED', checkout_url = NULL WHERE order_id = ${orderId}`.execute(
          trx,
        );
        await sql`UPDATE commerce.orders SET status = 'EXPIRED', closed_at = now() WHERE id = ${orderId}`.execute(
          trx,
        );
        await appendOrderTransition(trx, { orderId, toStatus: 'EXPIRED', cause: 'RECONCILER' });
        expect(await releaseCouponRedemptions(trx, orderId)).toBe(1);
      };
      const late = await createOrder(trx, {
        userId: await createUser(trx),
        lines: [{ instructorId: instructor, listAmount: '30.00', couponId: coupon }],
      });
      await openPayment(trx, late.orderId);
      await expire(late.orderId);
      await checkDeferredNow(trx);
      expect(await payOrder(trx, late)).toMatchObject({
        outcome: 'APPLIED',
        previousStatus: 'EXPIRED',
        consumedCoupons: 1,
      });

      const short = await createOrder(trx, {
        userId: await createUser(trx),
        lines: [{ instructorId: instructor, listAmount: '30.00', couponId: coupon }],
      });
      await openPayment(trx, short.orderId);
      await expire(short.orderId);
      expect(await payOrder(trx, short, { receivedAmount: '1.00' })).toMatchObject({
        outcome: 'MISMATCH',
        previousStatus: 'EXPIRED',
      });
      await checkDeferredNow(trx);
      const o = await sql<{ status: string; paidAt: Date | null; closedAt: Date | null }>`
        SELECT status, paid_at, closed_at FROM commerce.orders WHERE id = ${short.orderId}
      `.execute(trx);
      expect(o.rows[0]).toMatchObject({ status: 'PAYMENT_REVIEW', paidAt: null });
      expect(o.rows[0]!.closedAt).not.toBeNull();
    });
  });

  it('NOT_FOUND for an unknown order; requires a transaction and decimal-string money', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      expect(await payOrder(trx, { orderId: randomUUID(), totalAmount: '1.00' })).toMatchObject({
        outcome: 'NOT_FOUND',
      });
    });
  });
});

describe('refund dispatch', () => {
  it('lease (SKIP LOCKED + advisory lock) -> SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED, all COMMIT-consistent', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const order = await paidOrder(trx, ['25.00', '15.00']);
      const [l1, l2] = order.lines;
      const r1 = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l1!.id,
        userId: order.userId,
        amount: l1!.finalAmount,
      });
      const lease = await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE });
      expect(lease.locked).toBe(true);
      const mine = lease.refunds.find((r) => r.id === r1)!;
      expect(mine).toMatchObject({ orderId: order.orderId, amount: '25.00', attempt: 1 });
      expect(mine.paymentIntentId).toMatch(/^pi_itdb_/);
      expect(mine.claimedAt).toMatch(/\.\d{6}|\+/); // exact text, microseconds kept
      // a fresh lease is not taken again
      const again = await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE });
      expect(again.refunds.map((r) => r.id)).not.toContain(r1);

      // wrong fence (stale claimedAt) -> no-op
      expect(
        await completeRefundDispatch(trx, {
          refundId: r1,
          orderId: order.orderId,
          attempt: 1,
          claimedAt: '2000-01-01 00:00:00+00',
          status: 'SUCCEEDED',
          providerRefundId: `re_${r1}`,
        }),
      ).toEqual({ applied: false });
      const done = await completeRefundDispatch(trx, {
        refundId: r1,
        orderId: order.orderId,
        attempt: 1,
        claimedAt: mine.claimedAt,
        status: 'SUCCEEDED',
        providerRefundId: `re_${r1}`,
      });
      expect(done).toEqual({ applied: true, orderStatus: 'PARTIALLY_REFUNDED' });
      await checkDeferredNow(trx);

      const r2 = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l2!.id,
        userId: order.userId,
        amount: l2!.finalAmount,
      });
      const lease2 = await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE });
      const second = lease2.refunds.find((r) => r.id === r2)!;
      expect(
        await completeRefundDispatch(trx, {
          ...second,
          refundId: r2,
          status: 'SUBMITTED',
          providerRefundId: `re_${r2}`,
        }),
      ).toEqual({ applied: true });
      await checkDeferredNow(trx);
      // the refund webhook later settles SUBMITTED -> SUCCEEDED (T16); here by hand + the recompute
      await sql`UPDATE commerce.refunds SET status = 'SUCCEEDED', succeeded_at = now() WHERE id = ${r2}`.execute(
        trx,
      );
      await sql`
        INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, provider_refund_id)
        VALUES (${r2}, 3, 'SUBMITTED', 'SUCCEEDED', ${`re_${r2}`})
      `.execute(trx);
      expect(await applySucceededRefundsToOrder(trx, order.orderId)).toBe('REFUNDED');
      expect(await applySucceededRefundsToOrder(trx, order.orderId)).toBe('REFUNDED'); // idempotent
      await checkDeferredNow(trx);
    });
  });

  it('FAILED with a failure code, admin retry (attempt + 1) is leased again; release gives the lease back', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const order = await paidOrder(trx, ['25.00']);
      const l = order.lines[0]!;
      const id = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l.id,
        userId: order.userId,
        amount: l.finalAmount,
      });
      let leased = (await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })).refunds.find(
        (r) => r.id === id,
      )!;
      expect(
        await releaseRefundDispatchLease(trx, { refundId: id, claimedAt: leased.claimedAt }),
      ).toBe(true);
      expect(
        await releaseRefundDispatchLease(trx, { refundId: id, claimedAt: leased.claimedAt }),
      ).toBe(false);
      leased = (await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })).refunds.find(
        (r) => r.id === id,
      )!;
      expect(
        await failRefundDispatch(trx, {
          ...leased,
          refundId: id,
          failureCode: 'charge_already_refunded',
        }),
      ).toEqual({ applied: true });
      await checkDeferredNow(trx);
      await expect(
        failRefundDispatch(trx, { ...leased, refundId: id, failureCode: 'Bad Code' }),
      ).rejects.toThrow(RangeError);

      const admin = await createUser(trx);
      await sql`
        UPDATE commerce.refunds SET status = 'APPROVED', attempt = attempt + 1, failure_code = NULL, approved_at = now()
         WHERE id = ${id}
      `.execute(trx);
      await sql`
        INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, actor_id)
        VALUES (${id}, 3, 'FAILED', 'APPROVED', ${admin})
      `.execute(trx);
      await checkDeferredNow(trx);
      const retry = (
        await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })
      ).refunds.find((r) => r.id === id)!;
      expect(retry.attempt).toBe(2);
      // the old attempt's fence no longer matches
      expect(
        await completeRefundDispatch(trx, {
          ...retry,
          refundId: id,
          attempt: 1,
          status: 'SUCCEEDED',
          providerRefundId: 're_old',
        }),
      ).toEqual({ applied: false });
    });
  });

  it('a stale lease (crashed claim, > 2 min) is taken again', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const order = await paidOrder(trx, ['25.00']);
      const l = order.lines[0]!;
      const id = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l.id,
        userId: order.userId,
        amount: l.finalAmount,
      });
      expect(
        (await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })).refunds.map(
          (r) => r.id,
        ),
      ).toContain(id);
      expect(
        (await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })).refunds.map(
          (r) => r.id,
        ),
      ).not.toContain(id);
      await sql`UPDATE commerce.refunds SET dispatch_started_at = now() - interval '3 minutes' WHERE id = ${id}`.execute(
        trx,
      );
      expect(
        (await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })).refunds.map(
          (r) => r.id,
        ),
      ).toContain(id);
    });
  });

  it('a second dispatcher connection gets locked = false while the first holds the lock', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const held = signal();
    const done = signal();
    const first = rollback(pg.db, async (trx) => {
      await leaseRefundsForDispatch(trx, { batchSize: 1 });
      held.resolve();
      await done.promise;
    });
    await held.promise;
    const other = await leaseRefundsForDispatch(pg.db, { batchSize: 1 });
    done.resolve();
    await first;
    expect(other).toEqual({ locked: false, refunds: [] });
  });

  it('PAYMENT_REVIEW -> REFUNDED releases the RESERVED redemptions', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const buyer = await createUser(trx);
      const instructor = await createUser(trx);
      const admin = await createUser(trx);
      const coupon = await createCoupon(trx, { createdBy: instructor, percentOff: 10 });
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '30.00', couponId: coupon }],
      });
      expect(await payOrder(trx, order, { receivedAmount: '1.00' })).toMatchObject({
        outcome: 'MISMATCH',
      });
      const l = order.lines[0]!;
      const id = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l.id,
        userId: buyer,
        amount: l.finalAmount,
        initiatedBy: 'ADMIN',
        adminId: admin,
      });
      const leased = (
        await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })
      ).refunds.find((r) => r.id === id)!;
      expect(
        await completeRefundDispatch(trx, {
          ...leased,
          refundId: id,
          status: 'SUCCEEDED',
          providerRefundId: `re_${id}`,
        }),
      ).toEqual({ applied: true, orderStatus: 'REFUNDED' });
      await checkDeferredNow(trx);
      const red = await sql<{
        status: string;
      }>`SELECT status FROM commerce.coupon_redemptions WHERE order_id = ${order.orderId}`.execute(
        trx,
      );
      expect(red.rows).toEqual([{ status: 'RELEASED' }]);
    });
  });
});

describe('reconcile candidates', () => {
  it('stale CREATING payments and overdue OPEN sessions, with their thresholds', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const instructor = await createUser(trx);
      const mk = async (opts: { paymentCreatedAt?: Date; sessionExpiresAt?: Date }) =>
        createOrder(trx, {
          userId: await createUser(trx),
          lines: [{ instructorId: instructor, listAmount: '25.00' }],
          ...opts,
        });
      const ago = (min: number) => new Date(Date.now() - min * 60_000);
      const stale = await mk({ paymentCreatedAt: ago(20) });
      const fresh = await mk({ paymentCreatedAt: ago(5) });
      const overdue = await mk({ paymentCreatedAt: ago(60), sessionExpiresAt: ago(15) });
      const sid = await openPayment(trx, overdue.orderId);
      const recent = await mk({ paymentCreatedAt: ago(60), sessionExpiresAt: ago(5) });
      await openPayment(trx, recent.orderId);

      const creating = (await findStaleCreatingPayments(trx, { batchSize: MAX_BATCH_SIZE })).map(
        (p) => p.orderId,
      );
      expect(creating).toContain(stale.orderId);
      expect(creating).not.toContain(fresh.orderId);
      expect(
        (
          await findStaleCreatingPayments(trx, { batchSize: MAX_BATCH_SIZE, olderThanMinutes: 1 })
        ).map((p) => p.orderId),
      ).toContain(fresh.orderId);
      const open = await findOverdueOpenSessions(trx, { batchSize: MAX_BATCH_SIZE });
      expect(open.find((p) => p.orderId === overdue.orderId)).toMatchObject({
        checkoutSessionId: sid,
        userId: overdue.userId,
      });
      expect(open.map((p) => p.orderId)).not.toContain(recent.orderId);
      await expect(findOverdueOpenSessions(trx, { batchSize: 0 })).rejects.toThrow(RangeError);
    });
  });
});

describe('instructor sales', () => {
  it('summary by course with ROLLUP totals, refunds by succeeded_at; recent sales keyset', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const instructor = await createUser(trx);
      const a = await paidOrder(trx, ['25.00', '15.00'], instructor);
      const b = await paidOrder(trx, ['10.00'], instructor);
      const l = a.lines[0]!;
      const id = await createRefund(trx, {
        orderId: a.orderId,
        orderLineId: l.id,
        userId: a.userId,
        amount: l.finalAmount,
      });
      const leased = (
        await leaseRefundsForDispatch(trx, { batchSize: MAX_BATCH_SIZE })
      ).refunds.find((r) => r.id === id)!;
      await completeRefundDispatch(trx, {
        ...leased,
        refundId: id,
        status: 'SUCCEEDED',
        providerRefundId: `re_${id}`,
      });
      await checkDeferredNow(trx);

      const from = new Date(Date.now() - 86_400_000);
      const to = new Date(Date.now() + 86_400_000);
      const summary = await getInstructorSalesSummary(trx, { instructorId: instructor, from, to });
      // 25.00 + 15.00 + 10.00 sold (70% = 17.50 + 10.50 + 7.00), 25.00 refunded (17.50)
      expect(summary.total).toEqual({
        salesCount: '3',
        gross: '50.00',
        discounts: '0.00',
        refunded: '25.00',
        net: '25.00',
        instructorShare: '17.50',
      });
      expect(summary.byCourse).toHaveLength(3);
      expect(summary.byCourse.find((c) => c.courseId === l.courseId)).toMatchObject({
        salesCount: '1',
        net: '0.00',
      });
      const empty = await getInstructorSalesSummary(trx, {
        instructorId: await createUser(trx),
        from,
        to,
      });
      expect(empty.total.salesCount).toBe('0');
      await expect(
        getInstructorSalesSummary(trx, {
          instructorId: instructor,
          from,
          to: new Date(from.getTime() + 367 * 86_400_000),
        }),
      ).rejects.toThrow(RangeError);

      const page1 = await listRecentSales(trx, { instructorId: instructor, limit: 2 });
      expect(page1).toHaveLength(2);
      const page2 = await listRecentSales(trx, {
        instructorId: instructor,
        limit: 2,
        after: page1[1]!.cursor,
      });
      expect(page2).toHaveLength(1);
      const all = [...page1, ...page2];
      expect(new Set(all.map((s) => s.lineId))).toEqual(
        new Set([...a.lines, ...b.lines].map((x) => x.id)),
      );
      expect(all.find((s) => s.lineId === l.id)!.refunded).toBe(true);
      expect(page1[0]!.cursor.paidAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    });
  });

  it('rejects an empty range before querying', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const now = new Date();
    await expect(
      getInstructorSalesSummary(pg.db, { instructorId: randomUUID(), from: now, to: now }),
    ).rejects.toThrow(RangeError);
  });
});
