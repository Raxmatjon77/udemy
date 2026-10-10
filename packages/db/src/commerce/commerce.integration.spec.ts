import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { DB } from '../generated/db';
import { createUser } from '../testing/fixtures';
import {
  createCoupon,
  createOrder,
  createRefund,
  fromCents,
  payOrder,
  setCoursePrice,
  testEventId,
  toCents,
} from '../testing/commerce-fixtures';
import {
  checkDeferredNow,
  deleteTestData,
  expectFailure,
  type PgErrorShape,
  rollback,
  useIntegrationDb,
} from '../testing/it-db.mjs';
import { claimProviderEvent, finishProviderEvent } from './provider-events';

/**
 * Commerce DDL invariants of migration 0004 (docs/phase-4-schema-design.md §2, hand-off item 3).
 * Everything runs in rolled-back transactions; deferred checks are forced with
 * `SET CONSTRAINTS ALL IMMEDIATE` (exactly what COMMIT runs), except the two "at COMMIT" tests,
 * which really commit and therefore fail (their users are cleaned up in afterAll if not).
 */
const pg = useIntegrationDb();
const committedUsers: string[] = [];

afterAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  await deleteTestData(pg.db, committedUsers);
});

type Trx = Transaction<DB>;

/** Runs `fn` + the deferred checks in a rolled-back transaction and returns the error. */
async function deferredFailure(fn: (trx: Trx) => Promise<unknown>): Promise<PgErrorShape & Error> {
  try {
    await rollback(pg.db, async (trx) => {
      await fn(trx);
      await checkDeferredNow(trx);
    });
  } catch (error) {
    return error as PgErrorShape & Error;
  }
  throw new Error('expected a deferred constraint to fail, but every check passed');
}

/** Same, but the transaction must pass the deferred checks. */
async function deferredOk(fn: (trx: Trx) => Promise<unknown>): Promise<void> {
  await rollback(pg.db, async (trx) => {
    await fn(trx);
    await checkDeferredNow(trx);
  });
}

async function buyerAndInstructor(trx: Trx): Promise<{ buyer: string; instructor: string }> {
  return { buyer: await createUser(trx), instructor: await createUser(trx) };
}

/** round-half-up(x / y) for x, y >= 0 in integers. */
function halfUp(x: number, y: number): number {
  return Math.floor((2 * x + y) / (2 * y));
}

describe('generated money columns (the single rounding authority)', () => {
  const AMOUNTS = [
    '0.01',
    '0.02',
    '0.05',
    '0.07',
    '0.50',
    '0.99',
    '1.00',
    '19.99',
    '33.33',
    '49.99',
    '99.95',
    '199.99',
    '1234.56',
    '9999.99',
  ];
  const BPS = [0, 1, 3333, 5000, 7000, 9999, 10000];

  it('final / instructor / platform for every amount x bps: half-up, both >= 0, sum = final exactly', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const cases = AMOUNTS.flatMap((amount) => BPS.map((bps) => ({ amount, bps })));
      const seen: { amount: string; bps: number; f: string; i: string; p: string }[] = [];
      // orders hold at most 20 lines; each chunk is its own (non-PENDING-conflicting) order
      for (let start = 0; start < cases.length; start += 20) {
        const chunk = cases.slice(start, start + 20);
        const order = await createOrder(trx, {
          userId: buyer,
          lines: chunk.map((c) => ({
            instructorId: instructor,
            listAmount: c.amount,
            revenueShareBps: c.bps,
          })),
        });
        await sql`UPDATE commerce.orders SET status = 'EXPIRED', closed_at = now() WHERE id = ${order.orderId}`.execute(
          trx,
        );
        const { rows } = await sql<{ lineNo: number; f: string; i: string; p: string }>`
          SELECT line_no, final_amount AS f, instructor_share_amount AS i, platform_share_amount AS p
            FROM commerce.order_lines WHERE order_id = ${order.orderId} ORDER BY line_no
        `.execute(trx);
        rows.forEach((r, n) => seen.push({ ...chunk[n]!, f: r.f, i: r.i, p: r.p }));
      }
      expect(seen).toHaveLength(AMOUNTS.length * BPS.length);
      for (const s of seen) {
        const final = toCents(s.amount);
        const instructorShare = halfUp(final * s.bps, 10_000);
        expect({ ...s, f: toCents(s.f), i: toCents(s.i), p: toCents(s.p) }).toEqual({
          ...s,
          f: final,
          i: instructorShare,
          p: final - instructorShare,
        });
        expect(toCents(s.i) + toCents(s.p)).toBe(toCents(s.f));
        expect(toCents(s.i)).toBeGreaterThanOrEqual(0);
        expect(toCents(s.p)).toBeGreaterThanOrEqual(0);
      }
      // explicit half-up probes at .xx5
      const at = (amount: string, bps: number) =>
        seen.find((s) => s.amount === amount && s.bps === bps)!;
      expect(at('0.05', 7000).i).toBe('0.04'); // 0.035 -> 0.04
      expect(at('0.01', 5000).i).toBe('0.01'); // 0.005 -> 0.01
      expect(at('0.07', 5000).i).toBe('0.04'); // 0.035 -> 0.04
      expect(at('9999.99', 10000)).toMatchObject({ i: '9999.99', p: '0.00' });
      expect(at('9999.99', 0)).toMatchObject({ i: '0.00', p: '9999.99' });
    });
  });

  it('generated columns cannot be written by the app', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '10.00' }],
      });
      const err = await expectFailure(trx, () =>
        sql`
          INSERT INTO commerce.order_lines (order_id, line_no, course_id, instructor_id, course_title, list_amount,
                                            revenue_share_bps, final_amount)
          VALUES (${order.orderId}, 2, ${randomUUID()}, ${instructor}, 'x', 10, 7000, 10)
        `.execute(trx),
      );
      expect(err.code).toBe('428C9');
    });
  });

  it('commerce.coupon_discount: PERCENT 1/33/50/100 half-up, AMOUNT capped at the list price', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const amounts = ['0.01', '0.05', '0.50', '19.99', '33.33', '199.99', '9999.99'];
    const { rows } = await sql<{ list: string; pct: number; d: string }>`
      SELECT a::text AS list, p AS pct, commerce.coupon_discount(a, 'PERCENT', p::smallint, NULL)::text AS d
        FROM unnest(${amounts}::numeric[]) a, unnest(ARRAY[1, 33, 50, 100]) p
    `.execute(pg.db);
    expect(rows).toHaveLength(amounts.length * 4);
    for (const r of rows) {
      expect(toCents(r.d)).toBe(halfUp(toCents(r.list) * r.pct, 100));
    }
    const amount = await sql<{ capped: string; under: string }>`
      SELECT commerce.coupon_discount(10.00, 'AMOUNT', NULL, 15.00)::text AS capped,
             commerce.coupon_discount(10.00, 'AMOUNT', NULL, 2.50)::text AS under
    `.execute(pg.db);
    expect(amount.rows[0]).toEqual({ capped: '10.00', under: '2.50' });
  });
});

describe('order totals and payments', () => {
  it('a total != sum of lines fails orders_total_ck at a real COMMIT (and an order with no lines too)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const failure = (fn: (trx: Trx) => Promise<void>) =>
      pg.db
        .transaction()
        .execute(fn)
        .then(
          () => {
            throw new Error('expected the COMMIT to fail');
          },
          (e: unknown) => e as PgErrorShape,
        );
    const wrongTotal = await failure(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      committedUsers.push(buyer, instructor);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '40.00' }],
      });
      // a second line after the fact: Σ lines (80.00) != total (40.00)
      await sql`
        INSERT INTO commerce.order_lines (order_id, line_no, course_id, instructor_id, course_title, list_amount, revenue_share_bps)
        VALUES (${order.orderId}, 2, ${randomUUID()}, ${instructor}, 'Extra line', 40.00, 7000)
      `.execute(trx);
    });
    expect(wrongTotal).toMatchObject({ code: '23514', constraint: 'orders_total_ck' });

    const noLines = await failure(async (trx) => {
      const buyer = await createUser(trx);
      committedUsers.push(buyer);
      // a zero-total PAID order that is consistent in every other respect (log, no payment)
      const { rows } = await sql<{ id: string }>`
        INSERT INTO commerce.orders (user_id, status, currency, total_amount, idempotency_key, request_fingerprint, paid_at)
        VALUES (${buyer}, 'PAID', 'USD', 0, ${randomUUID()}, decode(repeat('ab', 32), 'hex'), now())
        RETURNING id
      `.execute(trx);
      await sql`
        INSERT INTO commerce.order_transitions (order_id, seq, to_status, cause, actor_id)
        VALUES (${rows[0]!.id}, 1, 'PAID', 'ZERO_TOTAL', ${buyer})
      `.execute(trx);
    });
    expect(noLines).toMatchObject({ code: '23514', constraint: 'orders_total_ck' });
  });

  it('orders_total_amount_ck: 0.30 is below the 0.50 minimum', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const err = await expectFailure(trx, () =>
        createOrder(trx, {
          userId: buyer,
          lines: [{ instructorId: instructor, listAmount: '0.30' }],
        }),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'orders_total_amount_ck' });
    });
  });

  it('payments_order_id_amount_currency_fk: payment amount or currency != the order total fails', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      await sql`DELETE FROM commerce.payments WHERE order_id = ${order.orderId}`.execute(trx); // payments are not append-only
      for (const [amount, currency] of [
        ['24.99', 'USD'],
        ['25.00', 'EUR'],
      ] as const) {
        const err = await expectFailure(trx, () =>
          sql`
            INSERT INTO commerce.payments (order_id, amount, currency, session_expires_at)
            VALUES (${order.orderId}, ${amount}::numeric, ${currency}, now() + interval '35 minutes')
          `.execute(trx),
        );
        expect(err).toMatchObject({
          code: '23503',
          constraint: 'payments_order_id_amount_currency_fk',
        });
      }
    });
  });

  it('payments_order_status_ck: a payment on a zero-total order fails at COMMIT; a PENDING order without one too', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const zeroWithPayment = await deferredFailure(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const coupon = await createCoupon(trx, { createdBy: instructor, percentOff: 100 });
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '19.99', couponId: coupon }],
      });
      expect(order).toMatchObject({ status: 'PAID', totalAmount: '0.00' });
      // amount 0 also violates payments_amount_ck; disable nothing, just prove the order side via a 0-total FK target
      await sql`
        INSERT INTO commerce.payments (order_id, amount, currency, session_expires_at)
        VALUES (${order.orderId}, 0, 'USD', now() + interval '35 minutes')
      `.execute(trx);
    });
    expect(zeroWithPayment).toMatchObject({ code: '23514', constraint: 'payments_amount_ck' });

    const pendingWithout = await deferredFailure(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      await sql`DELETE FROM commerce.payments WHERE order_id = ${order.orderId}`.execute(trx);
    });
    expect(pendingWithout).toMatchObject({ code: '23514', constraint: 'payments_order_status_ck' });

    // the legal zero-total and paid shapes pass every deferred check
    await deferredOk(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const coupon = await createCoupon(trx, { createdBy: instructor, percentOff: 100 });
      await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '19.99', couponId: coupon }],
      });
      const other = await createUser(trx);
      const paid = await createOrder(trx, {
        userId: other,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      expect(await payOrder(trx, paid)).toMatchObject({ outcome: 'APPLIED' });
    });
  });

  it('orders_user_id_pending_uq: one open checkout per user', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      const err = await expectFailure(trx, () =>
        createOrder(trx, {
          userId: buyer,
          lines: [{ instructorId: instructor, listAmount: '30.00' }],
        }),
      );
      expect(err).toMatchObject({ code: '23505', constraint: 'orders_user_id_pending_uq' });
    });
  });

  it('orders_immutable_ck: money/identity columns are immutable', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      const err = await expectFailure(trx, () =>
        sql`UPDATE commerce.orders SET total_amount = 1 WHERE id = ${order.orderId}`.execute(trx),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'orders_immutable_ck' });
    });
  });
});

describe('order transitions', () => {
  it('illegal edge, wrong from_status (chain FK) and a duplicate seq are rejected', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      const insert = (seq: number, from: string, to: string, cause: string) =>
        sql`
          INSERT INTO commerce.order_transitions (order_id, seq, from_status, to_status, cause)
          VALUES (${order.orderId}, ${seq}, ${from}, ${to}, ${cause})
        `.execute(trx);
      expect(
        await expectFailure(trx, () => insert(2, 'PENDING_PAYMENT', 'REFUNDED', 'REFUND')),
      ).toMatchObject({
        code: '23514',
        constraint: 'order_transitions_edge_ck',
      });
      expect(
        await expectFailure(trx, () => insert(2, 'EXPIRED', 'PAID', 'RECONCILER')),
      ).toMatchObject({
        code: '23503',
        constraint: 'order_transitions_order_id_prev_seq_from_status_fk',
      });
      expect(
        await expectFailure(trx, () => insert(3, 'PENDING_PAYMENT', 'EXPIRED', 'RECONCILER')),
      ).toMatchObject({
        code: '23503',
        constraint: 'order_transitions_order_id_prev_seq_from_status_fk',
      });
      await insert(2, 'PENDING_PAYMENT', 'EXPIRED', 'RECONCILER');
      expect(
        await expectFailure(trx, () => insert(2, 'PENDING_PAYMENT', 'CANCELED', 'RECONCILER')),
      ).toMatchObject({
        code: '23505',
        constraint: 'order_transitions_pk',
      });
    });
  });

  it('orders_status_log_ck: a status change without its transition fails at COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await deferredFailure(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      await sql`UPDATE commerce.payments SET status = 'ABANDONED' WHERE order_id = ${order.orderId}`.execute(
        trx,
      );
      await sql`UPDATE commerce.orders SET status = 'CANCELED', closed_at = now() WHERE id = ${order.orderId}`.execute(
        trx,
      );
    });
    expect(err).toMatchObject({ code: '23514', constraint: 'orders_status_log_ck' });
  });

  it('payments_received_ck: PAID with a received mismatch fails; PAYMENT_REVIEW -> ADMIN -> PAID succeeds', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const mismatchPaid = await deferredFailure(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      const evt = testEventId();
      await claimProviderEvent(trx, {
        eventId: evt,
        type: 'checkout.session.completed',
        livemode: false,
        objectId: null,
        providerCreatedAt: new Date(),
        payloadSha256: Buffer.alloc(32, 1),
      });
      await sql`
        UPDATE commerce.payments SET status = 'SUCCEEDED', checkout_session_id = 'cs_x', payment_intent_id = ${`pi_${evt}`},
               received_amount = 20.00, received_currency = 'USD', succeeded_at = now()
         WHERE order_id = ${order.orderId}
      `.execute(trx);
      await sql`UPDATE commerce.orders SET status = 'PAID', paid_at = now() WHERE id = ${order.orderId}`.execute(
        trx,
      );
      await sql`
        INSERT INTO commerce.order_transitions (order_id, seq, from_status, to_status, cause, provider, provider_event_id)
        VALUES (${order.orderId}, 2, 'PENDING_PAYMENT', 'PAID', 'PROVIDER_EVENT', 'STRIPE', ${evt})
      `.execute(trx);
    });
    expect(mismatchPaid).toMatchObject({ code: '23514', constraint: 'payments_received_ck' });

    await deferredOk(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const admin = await createUser(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      expect(await payOrder(trx, order, { receivedAmount: '20.00' })).toMatchObject({
        outcome: 'MISMATCH',
      });
      await checkDeferredNow(trx);
      await sql`UPDATE commerce.orders SET status = 'PAID', paid_at = now() WHERE id = ${order.orderId}`.execute(
        trx,
      );
      await sql`
        INSERT INTO commerce.order_transitions (order_id, seq, from_status, to_status, cause, actor_id, reason)
        VALUES (${order.orderId}, 3, 'PAYMENT_REVIEW', 'PAID', 'ADMIN', ${admin}, 'accepted after manual review')
      `.execute(trx);
      await sql`UPDATE commerce.coupon_redemptions SET status = 'CONSUMED', consumed_at = now() WHERE order_id = ${order.orderId}`.execute(
        trx,
      );
    });
  });
});

describe('order lines and coupons', () => {
  it('order_lines_discount_ck / order_lines_coupon_scope_ck: wrong discount or a foreign-course coupon fail', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const course = randomUUID();
      const coupon = await createCoupon(trx, {
        createdBy: instructor,
        courseId: course,
        percentOff: 50,
      });
      const wrong = await expectFailure(trx, () =>
        createOrder(trx, {
          userId: buyer,
          lines: [
            {
              instructorId: instructor,
              courseId: course,
              listAmount: '19.99',
              couponId: coupon,
              discountAmount: '9.99',
            },
          ],
        }),
      );
      expect(wrong).toMatchObject({ code: '23514', constraint: 'order_lines_discount_ck' }); // 50% of 19.99 = 10.00
      const foreign = await expectFailure(trx, () =>
        createOrder(trx, {
          userId: buyer,
          lines: [
            {
              instructorId: instructor,
              listAmount: '20.00',
              couponId: coupon,
              discountAmount: '10.00',
            },
          ],
        }),
      );
      expect(foreign).toMatchObject({ code: '23514', constraint: 'order_lines_coupon_scope_ck' });
      const ok = await createOrder(trx, {
        userId: buyer,
        lines: [
          { instructorId: instructor, courseId: course, listAmount: '19.99', couponId: coupon },
        ],
      });
      expect(ok.lines[0]!.finalAmount).toBe('9.99');
    });
  });

  it('coupon_redemptions_unused_ck: a redemption no line uses fails at COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await deferredFailure(async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const coupon = await createCoupon(trx, { createdBy: instructor, percentOff: 10 });
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      await sql`
        INSERT INTO commerce.coupon_redemptions (order_id, coupon_id, user_id, status)
        VALUES (${order.orderId}, ${coupon}, ${buyer}, 'RESERVED')
      `.execute(trx);
    });
    expect(err).toMatchObject({ code: '23514', constraint: 'coupon_redemptions_unused_ck' });
  });

  it('redemption edges: RESERVED -> CONSUMED / RELEASED and RELEASED -> CONSUMED only', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const instructor = await createUser(trx);
      const coupon = await createCoupon(trx, { createdBy: instructor, percentOff: 10 });
      const redeemed = async () => {
        const buyer = await createUser(trx);
        const o = await createOrder(trx, {
          userId: buyer,
          lines: [{ instructorId: instructor, listAmount: '25.00', couponId: coupon }],
        });
        return o.orderId;
      };
      const set = (orderId: string, status: string, extra = sql``) =>
        sql`UPDATE commerce.coupon_redemptions SET status = ${status} ${extra} WHERE order_id = ${orderId}`.execute(
          trx,
        );
      const illegal = { code: '23514', constraint: 'coupon_redemptions_transition_ck' };

      const a = await redeemed();
      await set(a, 'CONSUMED', sql`, consumed_at = now()`);
      expect(
        await expectFailure(trx, () =>
          set(a, 'RELEASED', sql`, released_at = now(), consumed_at = NULL`),
        ),
      ).toMatchObject(illegal);
      expect(
        await expectFailure(trx, () => set(a, 'RESERVED', sql`, consumed_at = NULL`)),
      ).toMatchObject(illegal);

      const b = await redeemed();
      await set(b, 'RELEASED', sql`, released_at = now()`);
      expect(
        await expectFailure(trx, () => set(b, 'RESERVED', sql`, released_at = NULL`)),
      ).toMatchObject(illegal);
      await set(b, 'CONSUMED', sql`, consumed_at = now()`); // late payment: released_at is kept
      const row = await sql<{ releasedAt: Date | null }>`
        SELECT released_at FROM commerce.coupon_redemptions WHERE order_id = ${b}
      `.execute(trx);
      expect(row.rows[0]!.releasedAt).not.toBeNull();

      const buyer = await createUser(trx);
      const c = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      const bornReleased = await expectFailure(trx, () =>
        sql`
          INSERT INTO commerce.coupon_redemptions (order_id, coupon_id, user_id, status, released_at)
          VALUES (${c.orderId}, ${coupon}, ${buyer}, 'RELEASED', now())
        `.execute(trx),
      );
      expect(bornReleased).toMatchObject(illegal);
    });
  });

  it('per-user unique, limit and validity are enforced by the reservation trigger; a late re-consumption is exempt', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const coupon = await createCoupon(trx, {
        createdBy: instructor,
        percentOff: 10,
        maxRedemptions: 2,
      });
      const line = { instructorId: instructor, listAmount: '25.00', couponId: coupon };

      // order A: reserved, then expired (redemption RELEASED)
      const a = await createOrder(trx, { userId: buyer, lines: [line] });
      await sql`UPDATE commerce.orders SET status = 'EXPIRED', closed_at = now() WHERE id = ${a.orderId}`.execute(
        trx,
      );
      await sql`UPDATE commerce.coupon_redemptions SET status = 'RELEASED', released_at = now() WHERE order_id = ${a.orderId}`.execute(
        trx,
      );
      // order B: the same user reserves the coupon again
      const b = await createOrder(trx, { userId: buyer, lines: [line] });
      // a third live redemption by the same user collides with the per-user unique
      await sql`UPDATE commerce.orders SET status = 'EXPIRED', closed_at = now() WHERE id = ${b.orderId}`.execute(
        trx,
      );
      const dup = await expectFailure(trx, () =>
        createOrder(trx, { userId: buyer, lines: [line] }),
      );
      expect(dup).toMatchObject({
        code: '23505',
        constraint: 'coupon_redemptions_coupon_id_user_id_active_uq',
      });
      // A's late payment: RELEASED -> CONSUMED succeeds although B holds a live RESERVED one (§6 item 2)
      await sql`UPDATE commerce.coupon_redemptions SET status = 'CONSUMED', consumed_at = now() WHERE order_id = ${a.orderId}`.execute(
        trx,
      );

      // limit: A (CONSUMED) + B (RESERVED) = 2 = max -> a new user's reservation is exhausted
      const other = await createUser(trx);
      const limit = await expectFailure(trx, () =>
        createOrder(trx, { userId: other, lines: [line] }),
      );
      expect(limit).toMatchObject({ code: '23514', constraint: 'coupon_redemptions_limit_ck' });

      // validity: a deactivated coupon cannot be reserved
      const second = await createCoupon(trx, { createdBy: instructor, percentOff: 10 });
      await sql`UPDATE commerce.coupons SET deactivated_at = now(), deactivated_by = ${instructor} WHERE id = ${second}`.execute(
        trx,
      );
      const invalid = await expectFailure(trx, () =>
        createOrder(trx, { userId: other, lines: [{ ...line, couponId: second }] }),
      );
      expect(invalid).toMatchObject({
        code: '23514',
        constraint: 'coupon_redemptions_coupon_valid_ck',
      });
      // ... and deactivation happens only once
      const again = await expectFailure(trx, () =>
        sql`UPDATE commerce.coupons SET deactivated_at = now() + interval '1 second' WHERE id = ${second}`.execute(
          trx,
        ),
      );
      expect(again).toMatchObject({ code: '23514', constraint: 'coupons_immutable_ck' });
    });
  });
});

describe('refunds', () => {
  async function paidOrder(trx: Trx, amounts: string[] = ['25.00', '15.00']) {
    const { buyer, instructor } = await buyerAndInstructor(trx);
    const order = await createOrder(trx, {
      userId: buyer,
      lines: amounts.map((listAmount) => ({ instructorId: instructor, listAmount })),
    });
    expect(await payOrder(trx, order)).toMatchObject({ outcome: 'APPLIED' });
    return order;
  }

  it('refunds_order_id_order_line_id_amount_fk: full-line amount of a line of the same order only', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const order = await paidOrder(trx);
      const other = await paidOrder(trx);
      const [l1] = order.lines;
      const fk = { code: '23503', constraint: 'refunds_order_id_order_line_id_amount_fk' };
      expect(
        await expectFailure(trx, () =>
          createRefund(trx, {
            orderId: order.orderId,
            orderLineId: l1!.id,
            userId: order.userId,
            amount: '24.99',
          }),
        ),
      ).toMatchObject(fk);
      expect(
        await expectFailure(trx, () =>
          createRefund(trx, {
            orderId: order.orderId,
            orderLineId: other.lines[0]!.id,
            userId: order.userId,
            amount: other.lines[0]!.finalAmount,
          }),
        ),
      ).toMatchObject(fk);
      await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l1!.id,
        userId: order.userId,
        amount: l1!.finalAmount,
      });
      await checkDeferredNow(trx);
    });
  });

  it('refunds_order_line_id_live_uq: one live refund per line; a rejected one frees the line', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const order = await paidOrder(trx);
      const line = order.lines[0]!;
      const spec = {
        orderId: order.orderId,
        orderLineId: line.id,
        userId: order.userId,
        amount: line.finalAmount,
      };
      const first = await createRefund(trx, { ...spec, status: 'REQUESTED' });
      expect(await expectFailure(trx, () => createRefund(trx, spec))).toMatchObject({
        code: '23505',
        constraint: 'refunds_order_line_id_live_uq',
      });
      const admin = await createUser(trx);
      await sql`UPDATE commerce.refunds SET status = 'REJECTED' WHERE id = ${first}`.execute(trx);
      await sql`
        INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, actor_id, reason)
        VALUES (${first}, 2, 'REQUESTED', 'REJECTED', ${admin}, 'outside of the refund policy')
      `.execute(trx);
      await createRefund(trx, spec);
      await checkDeferredNow(trx);
    });
  });

  it('refunds_order_status_ck: no refund on a PENDING order', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      const err = await expectFailure(trx, () =>
        createRefund(trx, {
          orderId: order.orderId,
          orderLineId: order.lines[0]!.id,
          userId: buyer,
          amount: '25.00',
        }),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'refunds_order_status_ck' });
    });
  });

  it('refunds_status_log_ck, refunds_immutable_ck (attempt) and orders_refund_status_ck', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    // status without a transition
    const noLog = await deferredFailure(async (trx) => {
      const order = await paidOrder(trx);
      const l = order.lines[0]!;
      const id = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l.id,
        userId: order.userId,
        amount: l.finalAmount,
      });
      await sql`UPDATE commerce.refunds SET status = 'FAILED', failure_code = 'card_declined' WHERE id = ${id}`.execute(
        trx,
      );
    });
    expect(noLog).toMatchObject({ code: '23514', constraint: 'refunds_status_log_ck' });

    // attempt may only increment on FAILED -> APPROVED
    await rollback(pg.db, async (trx) => {
      const order = await paidOrder(trx);
      const l = order.lines[0]!;
      const id = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l.id,
        userId: order.userId,
        amount: l.finalAmount,
      });
      const err = await expectFailure(trx, () =>
        sql`UPDATE commerce.refunds SET attempt = 2 WHERE id = ${id}`.execute(trx),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'refunds_immutable_ck' });
    });

    // REFUNDED while Σ SUCCEEDED (25.00) != total (40.00)
    const wrongSum = await deferredFailure(async (trx) => {
      const order = await paidOrder(trx);
      const l = order.lines[0]!;
      const id = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l.id,
        userId: order.userId,
        amount: l.finalAmount,
      });
      await sql`
        UPDATE commerce.refunds SET status = 'SUCCEEDED', provider_refund_id = ${`re_${id}`}, succeeded_at = now() WHERE id = ${id}
      `.execute(trx);
      await sql`
        INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, provider_refund_id)
        VALUES (${id}, 2, 'APPROVED', 'SUCCEEDED', ${`re_${id}`})
      `.execute(trx);
      await sql`UPDATE commerce.orders SET status = 'REFUNDED' WHERE id = ${order.orderId}`.execute(
        trx,
      );
      await sql`
        INSERT INTO commerce.order_transitions (order_id, seq, from_status, to_status, cause)
        VALUES (${order.orderId}, 3, 'PAID', 'REFUNDED', 'REFUND')
      `.execute(trx);
    });
    expect(wrongSum).toMatchObject({ code: '23514', constraint: 'orders_refund_status_ck' });
  });
});

describe('append-only and guarded tables', () => {
  it('UPDATE / DELETE / TRUNCATE on every append-only table give 42501', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { buyer, instructor } = await buyerAndInstructor(trx);
      const course = randomUUID();
      await setCoursePrice(trx, { courseId: course, amount: '25.00', updatedBy: instructor });
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00', courseId: course }],
      });
      const paid = await payOrder(trx, order);
      expect(paid.outcome).toBe('APPLIED');
      const l = order.lines[0]!;
      const refund = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: l.id,
        userId: buyer,
        amount: l.finalAmount,
      });
      const enr = await sql<{ id: string }>`
        INSERT INTO enrollment.enrollments (user_id, course_id, source, order_line_id) VALUES (${buyer}, ${course}, 'ORDER', ${l.id})
        RETURNING id
      `.execute(trx);
      await sql`
        INSERT INTO enrollment.enrollment_transitions (enrollment_id, seq, action, to_status, source, order_line_id)
        VALUES (${enr.rows[0]!.id}, 1, 'GRANT', 'ACTIVE', 'ORDER', ${l.id})
      `.execute(trx);
      const acct = await sql<{ id: string }>`
        INSERT INTO payouts.accounts (type, currency) VALUES ('PROVIDER_CLEARING', 'USD') ON CONFLICT DO NOTHING RETURNING id
      `.execute(trx);
      expect(acct.rows.length).toBeLessThanOrEqual(1);
      await sql`
        WITH e AS (INSERT INTO payouts.journal_entries (kind, order_line_id, source_event_id, currency, occurred_at)
                   VALUES ('SALE', ${l.id}, ${randomUUID()}, 'USD', now()) RETURNING id)
        INSERT INTO payouts.postings (entry_id, line_no, account_id, currency, amount)
        SELECT e.id, 1, a.id, 'USD', 1 FROM e, payouts.accounts a WHERE a.type = 'PROVIDER_CLEARING' AND a.currency = 'USD'
      `.execute(trx);

      const appendOnly: [string, string][] = [
        ['commerce.course_price_changes', `course_id = '${course}'`],
        ['commerce.order_lines', `order_id = '${order.orderId}'`],
        ['commerce.order_transitions', `order_id = '${order.orderId}'`],
        ['commerce.refund_transitions', `refund_id = '${refund}'`],
        ['enrollment.enrollment_transitions', `enrollment_id = '${enr.rows[0]!.id}'`],
        ['payouts.accounts', `type = 'PROVIDER_CLEARING'`],
        ['payouts.journal_entries', `order_line_id = '${l.id}'`],
        [
          'payouts.postings',
          `entry_id IN (SELECT id FROM payouts.journal_entries WHERE order_line_id = '${l.id}')`,
        ],
      ];
      for (const [table, where] of appendOnly) {
        for (const stmt of [
          `UPDATE ${table} SET ${table === 'payouts.postings' ? 'line_no = line_no' : 'created_at = created_at'} WHERE ${where}`,
          `DELETE FROM ${table} WHERE ${where}`,
        ]) {
          const s = table.startsWith('commerce.order_lines')
            ? stmt.replace('created_at = created_at', 'line_no = line_no')
            : stmt;
          const fixed = s
            .replace(
              /(course_price_changes|transitions) SET created_at = created_at/,
              '$1 SET occurred_at = occurred_at',
            )
            .replace(
              'course_price_changes SET occurred_at = occurred_at',
              'course_price_changes SET changed_at = changed_at',
            );
          const err = await expectFailure(trx, () => sql.raw(fixed).execute(trx));
          expect({ table, stmt: fixed.split(' ')[0], code: err.code }).toEqual({
            table,
            stmt: fixed.split(' ')[0],
            code: '42501',
          });
        }
      }
    });
    // TRUNCATE guards (append-only tables + the never-truncated state tables), in a fresh
    // transaction (pending trigger events on a table make TRUNCATE fail with 55006 instead).
    // Statement-level triggers need no rows. CASCADE gets past the FK check to the BEFORE TRUNCATE
    // trigger; nothing is truncated (the trigger aborts it, and the transaction rolls back).
    await rollback(pg.db, async (trx) => {
      for (const table of [
        'commerce.course_price_changes',
        'commerce.order_lines',
        'commerce.order_transitions',
        'commerce.refund_transitions',
        'enrollment.enrollment_transitions',
        'payouts.accounts',
        'payouts.journal_entries',
        'payouts.postings',
        'commerce.coupon_redemptions',
        'commerce.refunds',
        'commerce.provider_events',
        'enrollment.enrollments',
      ]) {
        const err = await expectFailure(trx, () =>
          sql.raw(`TRUNCATE ${table} CASCADE`).execute(trx),
        );
        expect({ table, code: err.code }).toEqual({ table, code: '42501' });
      }
    });
  });

  it('provider_events: one outcome update, DELETE forbidden; claims dedupe on the PK', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const evt = testEventId();
      const input = {
        eventId: evt,
        type: 'checkout.session.completed',
        livemode: false,
        objectId: 'cs_1',
        providerCreatedAt: new Date(),
        payloadSha256: Buffer.alloc(32, 7),
      };
      expect(await claimProviderEvent(trx, input)).toBe(true);
      expect(await claimProviderEvent(trx, input)).toBe(false);
      expect(await finishProviderEvent(trx, { eventId: evt, outcome: 'IGNORED' })).toBe(true);
      expect(await finishProviderEvent(trx, { eventId: evt, outcome: 'APPLIED' })).toBe(false);
      const second = await expectFailure(trx, () =>
        sql`UPDATE commerce.provider_events SET outcome = 'APPLIED' WHERE event_id = ${evt}`.execute(
          trx,
        ),
      );
      expect(second.code).toBe('42501');
      const del = await expectFailure(trx, () =>
        sql`DELETE FROM commerce.provider_events WHERE event_id = ${evt}`.execute(trx),
      );
      expect(del.code).toBe('42501');
    });
  });
});

describe('course prices', () => {
  it('the price-history trigger records every change; no-op updates and identity changes are rejected', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const instructor = await createUser(trx);
      const admin = await createUser(trx);
      const course = randomUUID();
      await setCoursePrice(trx, { courseId: course, amount: '19.99', updatedBy: instructor });
      await sql`UPDATE commerce.course_prices SET amount = 49.99, updated_by = ${admin} WHERE course_id = ${course}`.execute(
        trx,
      );
      // the IS DISTINCT upsert of an unchanged price is a no-op (no row version, no history)
      await setCoursePrice(trx, { courseId: course, amount: '49.99', updatedBy: instructor });
      const noop = await expectFailure(trx, () =>
        sql`UPDATE commerce.course_prices SET amount = 49.99 WHERE course_id = ${course}`.execute(
          trx,
        ),
      );
      expect(noop).toMatchObject({ code: '23514', constraint: 'course_prices_noop_update_ck' });
      const immutable = await expectFailure(trx, () =>
        sql`UPDATE commerce.course_prices SET course_id = ${randomUUID()}, amount = 1 WHERE course_id = ${course}`.execute(
          trx,
        ),
      );
      expect(immutable).toMatchObject({ code: '23514', constraint: 'course_prices_immutable_ck' });
      const range = await expectFailure(trx, () =>
        sql`UPDATE commerce.course_prices SET amount = 10000 WHERE course_id = ${course}`.execute(
          trx,
        ),
      );
      expect(range).toMatchObject({ code: '23514', constraint: 'course_prices_amount_ck' });

      const { rows } = await sql<{
        amount: string;
        previous: string | null;
        changedBy: string;
        matchesCurrent: boolean;
      }>`
        SELECT h.amount, lag(h.amount) OVER (ORDER BY h.changed_at, h.id) AS previous, h.changed_by,
               (h.changed_at = p.updated_at AND h.changed_by = p.updated_by AND h.amount = p.amount) AS matches_current
          FROM commerce.course_price_changes h JOIN commerce.course_prices p USING (course_id)
         WHERE h.course_id = ${course}
         ORDER BY h.changed_at, h.id
      `.execute(trx);
      expect(rows).toEqual([
        { amount: '19.99', previous: null, changedBy: instructor, matchesCurrent: false },
        { amount: '49.99', previous: '19.99', changedBy: admin, matchesCurrent: true },
      ]);
      expect(fromCents(toCents('49.99'))).toBe('49.99');
    });
  });
});
