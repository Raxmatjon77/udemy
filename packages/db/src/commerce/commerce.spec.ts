import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import {
  consumeCouponRedemptions,
  releaseCouponRedemptions,
  reserveCouponRedemption,
} from './coupons';
import {
  COMMERCE_RECONCILE_LOCK_KEY,
  lockOrder,
  lockUserCart,
  REFUND_DISPATCH_LOCK_KEY,
  tryAdvisoryXactLock,
} from './locks';
import { appendOrderTransition, markOrderPaid, type MarkOrderPaidInput } from './orders';
import { claimProviderEvent, finishProviderEvent } from './provider-events';
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

const ORDER = '01900000-0000-7000-8000-000000000001';
const USER = '01900000-0000-7000-8000-0000000000aa';

const PAID_INPUT: MarkOrderPaidInput = {
  orderId: ORDER,
  cause: 'PROVIDER_EVENT',
  providerEventId: 'evt_1',
  checkoutSessionId: 'cs_1',
  paymentIntentId: 'pi_1',
  receivedAmount: '25.00',
  receivedCurrency: 'USD',
};

const lockedOrder = (status: string) => ({
  rows: [
    { id: ORDER, user_id: USER, status, total_amount: '25.00', currency: 'USD', paid_at: null },
  ],
});

describe('advisory lock keys', () => {
  it('are 0x75646d79_03 (dispatch) and _04 (reconcile), distinct', () => {
    expect(REFUND_DISPATCH_LOCK_KEY).toBe(504196069635);
    expect(COMMERCE_RECONCILE_LOCK_KEY).toBe(504196069636);
  });
});

describe('row locks', () => {
  it('lock helpers refuse to run outside a transaction', async () => {
    const s = scriptedDb();
    await expect(lockUserCart(s.db, USER)).rejects.toThrow(/inside a transaction/);
    await expect(lockOrder(s.db, ORDER)).rejects.toThrow(/inside a transaction/);
    await expect(tryAdvisoryXactLock(s.db, 1)).rejects.toThrow(/inside a transaction/);
    await expect(markOrderPaid(s.db, PAID_INPUT)).rejects.toThrow(/inside a transaction/);
    expect(s.statements).toEqual([]);
  });

  it('lockUserCart ensures the cart row, then locks it FOR UPDATE', async () => {
    const s = scriptedDb([{}, { rows: [{ coupon_code: 'SAVE10' }] }]);
    const r = await s.db.transaction().execute((trx) => lockUserCart(trx, USER));
    expect(r).toEqual({ couponCode: 'SAVE10' });
    expect(s.statements[1]).toContain('ON CONFLICT (user_id) DO NOTHING');
    expect(s.statements[2]).toMatch(/FROM commerce\.carts WHERE user_id = \$1 FOR UPDATE$/);
  });
});

describe('markOrderPaid', () => {
  it('NOT_FOUND without touching locks when the order is unknown', async () => {
    const s = scriptedDb([{ rows: [] }]);
    const r = await s.db.transaction().execute((trx) => markOrderPaid(trx, PAID_INPUT));
    expect(r).toEqual({ outcome: 'NOT_FOUND' });
    expect(s.statements).toHaveLength(3); // BEGIN, owner lookup, COMMIT
  });

  it('DUPLICATE_EFFECT for an order already past PENDING/EXPIRED/CANCELED: lock order cart -> order, no writes', async () => {
    const s = scriptedDb([{ rows: [{ user_id: USER }] }, {}, { rows: [] }, lockedOrder('PAID')]);
    const r = await s.db.transaction().execute((trx) => markOrderPaid(trx, PAID_INPUT));
    expect(r).toEqual({ outcome: 'DUPLICATE_EFFECT', userId: USER, status: 'PAID' });
    const sqlText = s.statements.join('\n');
    expect(sqlText.indexOf('commerce.carts WHERE user_id')).toBeLessThan(
      sqlText.indexOf('commerce.orders WHERE id = $1 FOR UPDATE'),
    );
    expect(sqlText).not.toContain('UPDATE commerce.payments');
  });

  it('MISMATCH: payment SUCCEEDED, order PAYMENT_REVIEW + transition, redemptions untouched', async () => {
    const s = scriptedDb([
      { rows: [{ user_id: USER }] },
      {},
      { rows: [] },
      lockedOrder('PENDING_PAYMENT'),
      { rows: [{ matches: false }] },
      { numAffectedRows: 1n },
      { numAffectedRows: 1n },
      { rows: [{ seq: 2 }] },
    ]);
    const r = await s.db
      .transaction()
      .execute((trx) => markOrderPaid(trx, { ...PAID_INPUT, receivedAmount: '1.00' }));
    expect(r).toEqual({ outcome: 'MISMATCH', userId: USER, previousStatus: 'PENDING_PAYMENT' });
    expect(s.statements.some((q) => q.includes("SET status = 'PAYMENT_REVIEW'"))).toBe(true);
    expect(s.statements.some((q) => q.includes('commerce.coupon_redemptions'))).toBe(false);
    expect(s.statements.some((q) => q.includes('paid_at = now()'))).toBe(false);
  });

  it('APPLIED: PAID with paid_at, transition, CONSUMED redemptions, lines by course_id', async () => {
    const paidAt = new Date();
    const s = scriptedDb([
      { rows: [{ user_id: USER }] },
      {},
      { rows: [] },
      lockedOrder('CANCELED'),
      { rows: [{ matches: true }] },
      { numAffectedRows: 1n },
      { rows: [{ paid_at: paidAt }] },
      { rows: [{ seq: 3 }] },
      { numAffectedRows: 1n },
      { rows: [{ id: 'l1', course_id: 'c1' }] },
    ]);
    const r = await s.db.transaction().execute((trx) => markOrderPaid(trx, PAID_INPUT));
    expect(r).toMatchObject({
      outcome: 'APPLIED',
      previousStatus: 'CANCELED',
      paidAt,
      consumedCoupons: 1,
    });
    expect(s.statements.at(-2)).toContain('ORDER BY course_id');
  });

  it('throws when the payment cannot be settled (invariant breach), and validates money first', async () => {
    const s = scriptedDb([
      { rows: [{ user_id: USER }] },
      {},
      { rows: [] },
      lockedOrder('PENDING_PAYMENT'),
      { rows: [{ matches: true }] },
      { numAffectedRows: 0n },
    ]);
    await expect(
      s.db.transaction().execute((trx) => markOrderPaid(trx, PAID_INPUT)),
    ).rejects.toThrow(/no payment to settle/);
    const t = scriptedDb();
    await expect(
      t.db
        .transaction()
        .execute((trx) => markOrderPaid(trx, { ...PAID_INPUT, receivedAmount: '25' as string })),
    ).resolves.toEqual({
      outcome: 'NOT_FOUND',
    });
    await expect(
      t.db
        .transaction()
        .execute((trx) => markOrderPaid(trx, { ...PAID_INPUT, receivedAmount: '25.001' })),
    ).rejects.toThrow(RangeError);
    await expect(
      t.db
        .transaction()
        .execute((trx) => markOrderPaid(trx, { ...PAID_INPUT, receivedCurrency: 'usd' })),
    ).rejects.toThrow(RangeError);
  });

  it('appendOrderTransition: max(seq)+1 from the head, provider set only with an event id', async () => {
    const s = scriptedDb([{ rows: [{ seq: 1 }] }, { rows: [{ seq: 2 }] }]);
    await s.db.transaction().execute(async (trx) => {
      await appendOrderTransition(trx, {
        orderId: ORDER,
        toStatus: 'PENDING_PAYMENT',
        cause: 'CHECKOUT',
        actorId: USER,
      });
      await appendOrderTransition(trx, {
        orderId: ORDER,
        toStatus: 'PAID',
        cause: 'PROVIDER_EVENT',
        providerEventId: 'evt',
      });
    });
    expect(s.statements[1]).toContain('coalesce(h.seq, 0) + 1, h.to_status');
    expect(s.statements[1]).toContain('ORDER BY seq DESC LIMIT 1');
    expect(s.parameters[1]).toEqual([
      ORDER,
      'PENDING_PAYMENT',
      'CHECKOUT',
      null,
      null,
      USER,
      null,
      ORDER,
    ]);
    expect(s.parameters[2]).toEqual([
      ORDER,
      'PAID',
      'PROVIDER_EVENT',
      'STRIPE',
      'evt',
      null,
      null,
      ORDER,
    ]);
  });
});

describe('coupons', () => {
  it('reserve RESERVED (or CONSUMED for zero total) and the consume/release edges', async () => {
    const s = scriptedDb([{}, {}, { numAffectedRows: 2n }, { numAffectedRows: 0n }]);
    await s.db.transaction().execute(async (trx) => {
      await reserveCouponRedemption(trx, { orderId: ORDER, couponId: 'c', userId: USER });
      await reserveCouponRedemption(trx, {
        orderId: ORDER,
        couponId: 'c',
        userId: USER,
        consumed: true,
      });
      expect(await consumeCouponRedemptions(trx, ORDER)).toBe(2);
      expect(await releaseCouponRedemptions(trx, ORDER)).toBe(0);
    });
    expect(s.parameters[1]).toEqual([ORDER, 'c', USER, 'RESERVED', null]);
    expect(s.parameters[2]).toEqual([ORDER, 'c', USER, 'CONSUMED']);
    expect(s.statements[2]).toContain('$4, now())');
    expect(s.statements[3]).toContain("status IN ('RESERVED','RELEASED')");
    expect(s.statements[4]).toContain("status = 'RESERVED'");
    await expect(
      reserveCouponRedemption(scriptedDb().db, { orderId: ORDER, couponId: 'c', userId: USER }),
    ).rejects.toThrow(/inside a transaction/);
  });
});

describe('quote', () => {
  it('two statements (lines, candidates); coupon locks ascending FOR NO KEY UPDATE', async () => {
    const s = scriptedDb([
      { rows: [{ course_id: 'c1' }] },
      { rows: [{ id: 'k', state: 'ACTIVE' }] },
      { rows: [{ id: 'k' }] },
    ]);
    const q = await quoteCart(s.db, USER);
    expect(q).toEqual({ lines: [{ courseId: 'c1' }], candidates: [{ id: 'k', state: 'ACTIVE' }] });
    expect(s.statements[0]).toContain('commerce.coupon_discount(l.list_amount');
    expect(s.statements[0]).toContain(
      "ORDER BY discount_amount DESC, (c.scope = 'COURSE') DESC, c.id",
    );
    expect(s.statements[1]).toContain("'EXHAUSTED'");
    const ids = await s.db
      .transaction()
      .execute((trx) => lockCheckoutCoupons(trx, 'SAVE10', ['c1']));
    expect(ids).toEqual(['k']);
    expect(s.statements.at(-2)).toMatch(/ORDER BY id FOR NO KEY UPDATE$/);
  });
});

describe('provider events', () => {
  it('claim = ON CONFLICT DO NOTHING RETURNING; finish only once and validates the outcome', async () => {
    const s = scriptedDb([
      { rows: [{ event_id: 'e' }] },
      { rows: [] },
      { numAffectedRows: 1n },
      { numAffectedRows: 0n },
    ]);
    const input = {
      eventId: 'e',
      type: 'checkout.session.completed',
      livemode: false,
      objectId: null,
      providerCreatedAt: new Date(),
      payloadSha256: Buffer.alloc(32),
    };
    expect(await claimProviderEvent(s.db, input)).toBe(true);
    expect(await claimProviderEvent(s.db, input)).toBe(false);
    expect(
      await finishProviderEvent(s.db, { eventId: 'e', outcome: 'APPLIED', orderId: ORDER }),
    ).toBe(true);
    expect(await finishProviderEvent(s.db, { eventId: 'e', outcome: 'APPLIED' })).toBe(false);
    expect(s.statements[0]).toContain('ON CONFLICT (provider, event_id) DO NOTHING');
    expect(s.statements[2]).toContain('processed_at IS NULL');
    await expect(
      finishProviderEvent(s.db, { eventId: 'e', outcome: 'NOPE' as 'APPLIED' }),
    ).rejects.toThrow(RangeError);
    await expect(claimProviderEvent(s.db, { ...input, eventId: '' })).rejects.toThrow(RangeError);
  });
});

describe('refund dispatch', () => {
  it('lease: advisory lock first; locked = false skips the UPDATE', async () => {
    const s = scriptedDb([{ rows: [{ locked: false }] }]);
    expect(await leaseRefundsForDispatch(s.db, { batchSize: 10 })).toEqual({
      locked: false,
      refunds: [],
    });
    expect(s.statements).toEqual([
      'BEGIN',
      'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
      'COMMIT',
    ]);
    expect(s.parameters[1]).toEqual([REFUND_DISPATCH_LOCK_KEY]);
  });

  it('lease: SKIP LOCKED with the stale-lease bound, exact claimed_at text', async () => {
    const s = scriptedDb([
      { rows: [{ locked: true }] },
      { rows: [{ id: 'r', claimed_at: '2026-10-10 10:00:00.123456+00' }] },
    ]);
    const r = await leaseRefundsForDispatch(s.db, { batchSize: 5, staleLeaseSeconds: 60 });
    expect(r.refunds[0]).toMatchObject({ id: 'r', claimedAt: '2026-10-10 10:00:00.123456+00' });
    expect(s.statements[2]).toContain('FOR UPDATE SKIP LOCKED');
    expect(s.statements[2]).toContain('dispatch_started_at::text AS claimed_at');
    expect(s.parameters[2]).toEqual([60, 5]);
    await expect(leaseRefundsForDispatch(s.db, { batchSize: 0 })).rejects.toThrow(RangeError);
  });

  const fence = {
    refundId: 'r',
    orderId: ORDER,
    attempt: 1,
    claimedAt: '2026-10-10 10:00:00.123456+00',
  };

  it('complete: order lock first, fenced update; fence lost -> no transition', async () => {
    const s = scriptedDb([lockedOrder('PAID'), { rows: [] }]);
    const r = await s.db
      .transaction()
      .execute((trx) =>
        completeRefundDispatch(trx, { ...fence, status: 'SUBMITTED', providerRefundId: 're_1' }),
      );
    expect(r).toEqual({ applied: false });
    expect(s.statements[1]).toContain('commerce.orders WHERE id = $1 FOR UPDATE');
    expect(s.statements[2]).toContain('dispatch_started_at = $');
    expect(s.statements[2]).toContain('::timestamptz');
    expect(s.statements.some((q) => q.includes('refund_transitions'))).toBe(false);
  });

  it('complete SUCCEEDED recomputes the order (PAID -> PARTIALLY_REFUNDED); fail validates the code', async () => {
    const s = scriptedDb([
      lockedOrder('PAID'),
      { rows: [{ id: 'r' }] },
      {},
      { rows: [{ status: 'PAID', is_full: false, is_partial: true }] },
      {},
      { rows: [{ seq: 3 }] },
    ]);
    const r = await s.db
      .transaction()
      .execute((trx) =>
        completeRefundDispatch(trx, { ...fence, status: 'SUCCEEDED', providerRefundId: 're_1' }),
      );
    expect(r).toEqual({ applied: true, orderStatus: 'PARTIALLY_REFUNDED' });
    expect(s.parameters[5]).toEqual(['PARTIALLY_REFUNDED', ORDER, 'PAID']);
    expect(s.statements.some((q) => q.includes('coupon_redemptions'))).toBe(false);
    await expect(failRefundDispatch(s.db, { ...fence, failureCode: 'Not-Valid' })).rejects.toThrow(
      RangeError,
    );
    await expect(
      completeRefundDispatch(s.db, { ...fence, status: 'SUCCEEDED', providerRefundId: '' }),
    ).rejects.toThrow(RangeError);
  });

  it('applySucceededRefundsToOrder: PAYMENT_REVIEW -> REFUNDED releases redemptions; partial review stays', async () => {
    const full = scriptedDb([
      { rows: [{ status: 'PAYMENT_REVIEW', is_full: true, is_partial: false }] },
      {},
      { rows: [{ seq: 3 }] },
      {},
    ]);
    expect(
      await full.db.transaction().execute((trx) => applySucceededRefundsToOrder(trx, ORDER)),
    ).toBe('REFUNDED');
    expect(full.statements.at(-2)).toContain("SET status = 'RELEASED'");
    const partial = scriptedDb([
      { rows: [{ status: 'PAYMENT_REVIEW', is_full: false, is_partial: true }] },
    ]);
    expect(
      await partial.db.transaction().execute((trx) => applySucceededRefundsToOrder(trx, ORDER)),
    ).toBe('PAYMENT_REVIEW');
    expect(partial.statements).toHaveLength(3);
    const missing = scriptedDb([{ rows: [] }]);
    await expect(
      missing.db.transaction().execute((trx) => applySucceededRefundsToOrder(trx, ORDER)),
    ).rejects.toThrow(/not found/);
  });

  it('release is fenced on claimed_at', async () => {
    const s = scriptedDb([{ numAffectedRows: 1n }]);
    expect(
      await releaseRefundDispatchLease(s.db, { refundId: 'r', claimedAt: fence.claimedAt }),
    ).toBe(true);
    expect(s.statements[0]).toContain(
      "status = 'APPROVED' AND dispatch_started_at = $2::timestamptz",
    );
  });
});

describe('reconcile and sales', () => {
  it('reconcile scans use their partial indexes and defaults (15 / 10 min)', async () => {
    const s = scriptedDb();
    await findStaleCreatingPayments(s.db, { batchSize: 50 });
    await findOverdueOpenSessions(s.db, { batchSize: 50 });
    expect(s.statements[0]).toContain(
      "p.status = 'CREATING' AND p.created_at < now() - make_interval(mins => $1)",
    );
    expect(s.parameters[0]).toEqual([15, 50]);
    expect(s.statements[1]).toContain("p.status = 'OPEN' AND p.session_expires_at < now()");
    expect(s.parameters[1]).toEqual([10, 50]);
    await expect(
      findStaleCreatingPayments(s.db, { batchSize: 1, olderThanMinutes: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('sales summary maps the ROLLUP row to total; recent sales keyset only after page 1', async () => {
    const s = scriptedDb([
      {
        rows: [
          {
            course_id: null,
            sales_count: '2',
            gross: '9',
            discounts: '0',
            refunded: '0',
            net: '9',
            instructor_share: '6.30',
          },
          {
            course_id: 'c1',
            sales_count: '2',
            gross: '9',
            discounts: '0',
            refunded: '0',
            net: '9',
            instructor_share: '6.30',
          },
        ],
      },
      { rows: [{ line_id: 'l2', cursor_at: '2026-10-10 10:00:00.123456+00' }] },
      { rows: [] },
    ]);
    const from = new Date('2026-01-01T00:00:00Z');
    const summary = await getInstructorSalesSummary(s.db, {
      instructorId: USER,
      from,
      to: new Date('2026-12-31T00:00:00Z'),
    });
    expect(summary.total).toEqual({
      salesCount: '2',
      gross: '9',
      discounts: '0',
      refunded: '0',
      net: '9',
      instructorShare: '6.30',
    });
    expect(summary.byCourse).toEqual([expect.objectContaining({ courseId: 'c1' })]);
    expect(s.statements[0]).toContain('GROUP BY ROLLUP (course_id)');
    const page = await listRecentSales(s.db, { instructorId: USER, limit: 10 });
    expect(page[0]!.cursor).toEqual({ paidAt: '2026-10-10 10:00:00.123456+00', lineId: 'l2' });
    expect(s.statements[1]).not.toContain('(o.paid_at, l.id) <');
    await listRecentSales(s.db, { instructorId: USER, limit: 10, after: page[0]!.cursor });
    expect(s.statements[2]).toContain('(o.paid_at, l.id) < ($2::timestamptz, $3::uuid)');
    await expect(
      getInstructorSalesSummary(s.db, { instructorId: USER, from, to: from }),
    ).rejects.toThrow(RangeError);
    await expect(listRecentSales(s.db, { instructorId: USER, limit: 201 })).rejects.toThrow(
      RangeError,
    );
  });
});
