import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { claimProviderEvent } from '../commerce/provider-events';
import { type MarkOrderPaidResult, markOrderPaid } from '../commerce/orders';
import { type Executor, inTransaction } from '../transaction';
import { uniqueSuffix } from './fixtures';

/**
 * Test-data builders for commerce / enrollment / payouts integration tests. They write the legal
 * shapes the deferred guards accept at COMMIT (order + redemptions + lines + payment + seq-1
 * transition in one transaction), so tests can then break exactly one invariant.
 * Money is always a decimal string.
 */

export function toCents(amount: string): number {
  const [whole, frac = ''] = amount.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function fromCents(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** A fresh, valid coupon / course code (^[A-Z0-9_-]{4,20}$). */
export function uniqueCode(prefix = 'IT'): string {
  return `${prefix}${uniqueSuffix().toUpperCase()}`.slice(0, 20);
}

/** A synthetic provider event id, unique per call. */
export function testEventId(): string {
  return `evt_itdb_${uniqueSuffix()}${uniqueSuffix()}`;
}

export async function setCoursePrice(
  ex: Executor,
  opts: { courseId: string; amount: string; updatedBy: string; currency?: string },
): Promise<void> {
  await sql`
    INSERT INTO commerce.course_prices (course_id, amount, currency, updated_by)
    VALUES (${opts.courseId}, ${opts.amount}::numeric, ${opts.currency ?? 'USD'}, ${opts.updatedBy})
    ON CONFLICT (course_id) DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, updated_by = EXCLUDED.updated_by
     WHERE (course_prices.amount, course_prices.currency) IS DISTINCT FROM (EXCLUDED.amount, EXCLUDED.currency)
  `.execute(ex);
}

export interface CouponOptions {
  createdBy: string;
  /** Set for a COURSE coupon; omitted = PLATFORM. */
  courseId?: string;
  code?: string;
  percentOff?: number;
  /** AMOUNT coupon (course scope only). */
  amountOff?: string;
  maxRedemptions?: number | null;
  /** Default: active now for 30 days (course) / 60 days (platform). */
  startsAt?: Date;
  endsAt?: Date;
}

export async function createCoupon(ex: Executor, opts: CouponOptions): Promise<string> {
  const scope = opts.courseId === undefined ? 'PLATFORM' : 'COURSE';
  const amount = opts.amountOff !== undefined;
  const startsAt = opts.startsAt ?? new Date(Date.now() - 60_000);
  const endsAt =
    opts.endsAt ?? new Date(startsAt.getTime() + (scope === 'COURSE' ? 30 : 60) * 86_400_000);
  const { rows } = await sql<{ id: string }>`
    INSERT INTO commerce.coupons (scope, course_id, code, discount_type, percent_off, amount_off, currency,
                                  starts_at, ends_at, max_redemptions, created_by)
    VALUES (${scope}, ${opts.courseId ?? null}, ${opts.code ?? uniqueCode('C')}, ${amount ? 'AMOUNT' : 'PERCENT'},
            ${amount ? null : (opts.percentOff ?? 50)}, ${opts.amountOff ?? null}::numeric, ${amount ? 'USD' : null},
            ${startsAt}, ${endsAt}, ${opts.maxRedemptions ?? null}, ${opts.createdBy})
    RETURNING id
  `.execute(ex);
  return rows[0]!.id;
}

export interface OrderLineSpec {
  courseId?: string;
  instructorId: string;
  listAmount: string;
  couponId?: string;
  /** Default with a coupon: commerce.coupon_discount of its terms. */
  discountAmount?: string;
  revenueShareBps?: number;
  courseTitle?: string;
}

export interface TestOrder {
  orderId: string;
  userId: string;
  totalAmount: string;
  status: 'PENDING_PAYMENT' | 'PAID';
  lines: { id: string; courseId: string; finalAmount: string }[];
}

/**
 * Checkout tx A (§8.2) without the cart: order, one redemption per distinct coupon, lines,
 * payment (total > 0) and the seq-1 transition. A zero total is born PAID (ZERO_TOTAL).
 */
export async function createOrder(
  executor: Executor,
  opts: {
    userId: string;
    lines: OrderLineSpec[];
    currency?: string;
    /** Back-date the payment (reconciler tests); session_expires_at must stay > created_at. */
    paymentCreatedAt?: Date;
    sessionExpiresAt?: Date;
  },
): Promise<TestOrder> {
  return inTransaction(executor, async (trx) => {
    const currency = opts.currency ?? 'USD';
    const specs = [];
    for (const l of opts.lines) {
      let discount = l.discountAmount ?? '0';
      if (l.couponId !== undefined && l.discountAmount === undefined) {
        const { rows } = await sql<{ d: string }>`
          SELECT commerce.coupon_discount(${l.listAmount}::numeric, discount_type, percent_off, amount_off)::numeric(12,2) AS d
            FROM commerce.coupons WHERE id = ${l.couponId}
        `.execute(trx);
        discount = rows[0]!.d;
      }
      specs.push({ ...l, courseId: l.courseId ?? randomUUID(), discount });
    }
    const totalCents = specs.reduce((s, l) => s + toCents(l.listAmount) - toCents(l.discount), 0);
    const total = fromCents(totalCents);
    const zero = totalCents === 0;
    const { rows: o } = await sql<{ id: string }>`
      INSERT INTO commerce.orders (user_id, status, currency, total_amount, idempotency_key, request_fingerprint, paid_at)
      VALUES (${opts.userId}, ${zero ? 'PAID' : 'PENDING_PAYMENT'}, ${currency}, ${total}::numeric, ${randomUUID()},
              ${createHash('sha256').update(randomUUID()).digest()}, ${zero ? sql`now()` : null})
      RETURNING id
    `.execute(trx);
    const orderId = o[0]!.id;
    for (const couponId of [...new Set(specs.flatMap((l) => (l.couponId ? [l.couponId] : [])))]) {
      await sql`
        INSERT INTO commerce.coupon_redemptions (order_id, coupon_id, user_id, status, consumed_at)
        VALUES (${orderId}, ${couponId}, ${opts.userId}, ${zero ? 'CONSUMED' : 'RESERVED'}, ${zero ? sql`now()` : null})
      `.execute(trx);
    }
    const lines: TestOrder['lines'] = [];
    for (const [i, l] of specs.entries()) {
      const { rows } = await sql<{ id: string; finalAmount: string }>`
        INSERT INTO commerce.order_lines (order_id, line_no, course_id, instructor_id, course_title, list_amount,
                                          discount_amount, coupon_id, revenue_share_bps)
        VALUES (${orderId}, ${i + 1}, ${l.courseId}, ${l.instructorId}, ${l.courseTitle ?? 'IT course'},
                ${l.listAmount}::numeric, ${l.discount}::numeric, ${l.couponId ?? null}, ${l.revenueShareBps ?? 7000})
        RETURNING id, final_amount
      `.execute(trx);
      lines.push({ id: rows[0]!.id, courseId: l.courseId, finalAmount: rows[0]!.finalAmount });
    }
    if (!zero) {
      await sql`
        INSERT INTO commerce.payments (order_id, amount, currency, session_expires_at, created_at)
        VALUES (${orderId}, ${total}::numeric, ${currency},
                ${opts.sessionExpiresAt ?? sql`date_trunc('second', now()) + interval '35 minutes'`},
                ${opts.paymentCreatedAt ?? sql`now()`})
      `.execute(trx);
    }
    await sql`
      INSERT INTO commerce.order_transitions (order_id, seq, from_status, to_status, cause, actor_id)
      VALUES (${orderId}, 1, NULL, ${zero ? 'PAID' : 'PENDING_PAYMENT'}, ${zero ? 'ZERO_TOTAL' : 'CHECKOUT'}, ${opts.userId})
    `.execute(trx);
    return {
      orderId,
      userId: opts.userId,
      totalAmount: total,
      status: zero ? 'PAID' : 'PENDING_PAYMENT',
      lines,
    };
  });
}

/** tx B: CREATING -> OPEN with a session id and URL. Returns the session id. */
export async function openPayment(ex: Executor, orderId: string): Promise<string> {
  const sessionId = `cs_itdb_${uniqueSuffix()}${uniqueSuffix()}`;
  await sql`
    UPDATE commerce.payments SET status = 'OPEN', checkout_session_id = ${sessionId},
           checkout_url = ${`https://checkout.example.test/${sessionId}`}
     WHERE order_id = ${orderId} AND status = 'CREATING'
  `.execute(ex);
  return sessionId;
}

/** Webhook completed for the order: claims a fresh event and runs markOrderPaid. */
export async function payOrder(
  executor: Executor,
  order: Pick<TestOrder, 'orderId' | 'totalAmount'>,
  opts: { receivedAmount?: string; eventId?: string } = {},
): Promise<MarkOrderPaidResult & { eventId: string }> {
  return inTransaction(executor, async (trx) => {
    const eventId = opts.eventId ?? testEventId();
    const { rows } = await sql<{ sid: string | null }>`
      SELECT checkout_session_id AS sid FROM commerce.payments WHERE order_id = ${order.orderId}
    `.execute(trx);
    const sessionId = rows[0]?.sid ?? `cs_itdb_${uniqueSuffix()}`;
    await claimProviderEvent(trx, {
      eventId,
      type: 'checkout.session.completed',
      livemode: false,
      objectId: sessionId,
      providerCreatedAt: new Date(),
      payloadSha256: createHash('sha256').update(eventId).digest(),
    });
    const result = await markOrderPaid(trx, {
      orderId: order.orderId,
      cause: 'PROVIDER_EVENT',
      providerEventId: eventId,
      checkoutSessionId: sessionId,
      paymentIntentId: `pi_itdb_${uniqueSuffix()}${uniqueSuffix()}`,
      receivedAmount: opts.receivedAmount ?? order.totalAmount,
      receivedCurrency: 'USD',
    });
    return { ...result, eventId };
  });
}

export interface RefundSpec {
  orderId: string;
  orderLineId: string;
  userId: string;
  amount: string;
  /** Default APPROVED by the STUDENT (auto-approve). */
  status?: 'REQUESTED' | 'APPROVED';
  initiatedBy?: 'STUDENT' | 'ADMIN' | 'SYSTEM';
  /** ADMIN initiator (actor of the first transition, reason >= 10). */
  adminId?: string;
}

/** Refund + its seq-1 transition (RequestRefund / admin refund / SYSTEM duplicate). */
export async function createRefund(executor: Executor, spec: RefundSpec): Promise<string> {
  return inTransaction(executor, async (trx) => {
    const status = spec.status ?? 'APPROVED';
    const by = spec.initiatedBy ?? 'STUDENT';
    const reasonCode =
      by === 'STUDENT'
        ? 'NOT_AS_EXPECTED'
        : by === 'ADMIN'
          ? 'ADMIN_DISCRETION'
          : 'DUPLICATE_PURCHASE';
    const { rows } = await sql<{ id: string }>`
      INSERT INTO commerce.refunds (order_id, order_line_id, user_id, amount, status, initiated_by, reason_code, approved_at)
      VALUES (${spec.orderId}, ${spec.orderLineId}, ${spec.userId}, ${spec.amount}::numeric, ${status}, ${by},
              ${reasonCode}, ${status === 'APPROVED' ? sql`now()` : null})
      RETURNING id
    `.execute(trx);
    const id = rows[0]!.id;
    const actor = by === 'STUDENT' ? spec.userId : by === 'ADMIN' ? (spec.adminId ?? null) : null;
    await sql`
      INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, actor_id, reason)
      VALUES (${id}, 1, NULL, ${status}, ${actor}, ${by === 'ADMIN' ? 'admin refund for the tests' : null})
    `.execute(trx);
    return id;
  });
}
