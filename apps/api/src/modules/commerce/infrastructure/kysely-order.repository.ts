import { Injectable } from '@nestjs/common';
import type { OrderStatus, PaymentStatus, RefundStatus } from '@udemy/contracts';
import {
  appendOrderTransition,
  type DB,
  type Executor,
  findOrderOwner,
  lockOrder,
  markOrderPaid,
  releaseCouponRedemptions,
  reserveCouponRedemption,
  sql,
  type Transaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { IdempotentOrder } from '../domain/checkout';
import { Money } from '../domain/money';
import {
  type CheckoutSnapshot,
  type CloseOrderInput,
  type LockedOrderRecord,
  type MarkPaidInput,
  type MarkPaidResult,
  type NewOrder,
  type OrderDetailRecord,
  type OrderHeaderRecord,
  type OrderKeyset,
  OrderRepository,
  type OrderSummaryRecord,
  type PaidOrderLineRecord,
  type PlacedOrder,
} from '../application/ports/order.repository';

/** pg returns bigint (`order_number`) as a string; it is an identity far below 2^53. */
function orderNumberOf(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Invalid order number ${value}`);
  return n;
}

interface HeaderRow {
  id: string;
  orderNumber: string;
  userId: string;
  status: OrderStatus;
  currency: string;
  totalAmount: string;
  placedAt: Date;
  paidAt: Date | null;
  closedAt: Date | null;
}

function toHeader(row: HeaderRow): OrderHeaderRecord {
  return {
    orderId: row.id,
    orderNumber: orderNumberOf(row.orderNumber),
    userId: row.userId,
    status: row.status,
    currency: row.currency,
    totalAmount: row.totalAmount,
    placedAt: row.placedAt,
    paidAt: row.paidAt,
    closedAt: row.closedAt,
  };
}

/**
 * Orders, lines, payments, transitions and redemptions (schema doc §8.2–§8.5). Every write is
 * called under the caller's cart + order locks (R8); timestamps are SQL `now()` (the deferred
 * status/log guards compare them for equality, §7). Constraint violations are NOT mapped here:
 * checkout maps them with the fresh quote, the transaction runner maps the context-free ones.
 */
@Injectable()
export class KyselyOrderRepository extends OrderRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findByIdempotencyKey(
    trx: Transaction<DB>,
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotentOrder | null> {
    const { rows } = await sql<{
      id: string;
      status: OrderStatus;
      currency: string;
      totalAmount: string;
      paymentStatus: PaymentStatus | null;
      checkoutUrl: string | null;
      sessionExpiresAt: Date | null;
    }>`
      SELECT o.id, o.status, o.currency, o.total_amount, p.status AS payment_status,
             p.checkout_url, p.session_expires_at
        FROM commerce.orders o LEFT JOIN commerce.payments p ON p.order_id = o.id
       WHERE o.user_id = ${userId} AND o.idempotency_key = ${idempotencyKey}
    `.execute(trx);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      orderId: row.id,
      status: row.status,
      total: Money.fromDecimal(row.totalAmount, row.currency),
      paymentStatus: row.paymentStatus,
      checkoutUrl: row.checkoutUrl,
      sessionExpiresAt: row.sessionExpiresAt,
    };
  }

  async findPendingCheckout(
    userId: string,
    ex: Executor = this.db,
  ): Promise<{ orderId: string; checkoutUrl: string | null } | null> {
    const { rows } = await sql<{ id: string; checkoutUrl: string | null }>`
      SELECT o.id, p.checkout_url
        FROM commerce.orders o LEFT JOIN commerce.payments p ON p.order_id = o.id
       WHERE o.user_id = ${userId} AND o.status = 'PENDING_PAYMENT'
    `.execute(ex);
    const row = rows[0];
    return row === undefined ? null : { orderId: row.id, checkoutUrl: row.checkoutUrl };
  }

  async placeOrder(trx: Transaction<DB>, order: NewOrder): Promise<PlacedOrder> {
    const zero = Money.fromDecimal(order.totalAmount, order.currency).isZero();
    const fingerprint = Buffer.from(order.fingerprint, 'hex');
    if (fingerprint.length !== 32) throw new RangeError('fingerprint must be 32 bytes of hex');

    const { rows: placed } = await sql<{
      id: string;
      orderNumber: string;
      placedAt: Date;
      paidAt: Date | null;
    }>`
      INSERT INTO commerce.orders
        (user_id, status, currency, total_amount, idempotency_key, request_fingerprint, paid_at)
      VALUES (${order.userId}, ${zero ? 'PAID' : 'PENDING_PAYMENT'}, ${order.currency},
              ${order.totalAmount}::numeric, ${order.idempotencyKey}, ${fingerprint},
              ${zero ? sql`now()` : null})
      RETURNING id, order_number, placed_at, paid_at
    `.execute(trx);
    const head = placed[0];
    if (head === undefined) throw new Error('order insert returned nothing');

    // One redemption per distinct coupon, before the lines that reference it (FK).
    const couponIds = [
      ...new Set(order.lines.flatMap((l) => (l.couponId === null ? [] : [l.couponId]))),
    ].sort();
    for (const couponId of couponIds) {
      await reserveCouponRedemption(trx, {
        orderId: head.id,
        couponId,
        userId: order.userId,
        consumed: zero,
      });
    }

    const lines = await trx
      .insertInto('commerce.orderLines')
      .values(
        order.lines.map((line, index) => ({
          orderId: head.id,
          lineNo: index + 1,
          courseId: line.courseId,
          instructorId: line.instructorId,
          courseTitle: line.courseTitle,
          listAmount: line.listAmount,
          discountAmount: line.discountAmount,
          couponId: line.couponId,
          revenueShareBps: order.revenueShareBps,
        })),
      )
      .returning(['id', 'lineNo', 'courseId'])
      .execute();

    if (!zero) {
      await sql`
        INSERT INTO commerce.payments (order_id, amount, currency, session_expires_at)
        VALUES (${head.id}, ${order.totalAmount}::numeric, ${order.currency},
                date_trunc('second', now()) + make_interval(mins => ${order.sessionTtlMinutes}::int))
      `.execute(trx);
    }
    await appendOrderTransition(trx, {
      orderId: head.id,
      toStatus: zero ? 'PAID' : 'PENDING_PAYMENT',
      cause: zero ? 'ZERO_TOTAL' : 'CHECKOUT',
      actorId: order.userId,
    });
    return {
      orderId: head.id,
      orderNumber: orderNumberOf(head.orderNumber),
      status: zero ? 'PAID' : 'PENDING_PAYMENT',
      placedAt: head.placedAt,
      paidAt: head.paidAt,
      lines: lines
        .map((l) => ({ id: l.id, lineNo: l.lineNo, courseId: l.courseId }))
        .sort((a, b) => a.lineNo - b.lineNo),
    };
  }

  async findCheckoutSnapshot(
    orderId: string,
    ex: Executor = this.db,
  ): Promise<CheckoutSnapshot | null> {
    const { rows } = await sql<{
      id: string;
      userId: string;
      status: OrderStatus;
      currency: string;
      totalAmount: string;
      paymentStatus: PaymentStatus | null;
      sessionExpiresAt: Date | null;
      checkoutSessionId: string | null;
      checkoutUrl: string | null;
    }>`
      SELECT o.id, o.user_id, o.status, o.currency, o.total_amount, p.status AS payment_status,
             p.session_expires_at, p.checkout_session_id, p.checkout_url
        FROM commerce.orders o LEFT JOIN commerce.payments p ON p.order_id = o.id
       WHERE o.id = ${orderId}
    `.execute(ex);
    const row = rows[0];
    if (row === undefined) return null;
    const lines = await ex
      .selectFrom('commerce.orderLines')
      .select(['courseTitle', 'finalAmount'])
      .where('orderId', '=', orderId)
      .orderBy('lineNo')
      .execute();
    return {
      orderId: row.id,
      userId: row.userId,
      status: row.status,
      currency: row.currency,
      totalAmount: row.totalAmount,
      paymentStatus: row.paymentStatus,
      sessionExpiresAt: row.sessionExpiresAt,
      checkoutSessionId: row.checkoutSessionId,
      checkoutUrl: row.checkoutUrl,
      lines,
    };
  }

  async openPayment(
    trx: Transaction<DB>,
    orderId: string,
    session: { sessionId: string; url: string },
  ): Promise<boolean> {
    const { rows } = await sql<{ orderId: string }>`
      UPDATE commerce.payments
         SET status = 'OPEN', checkout_session_id = ${session.sessionId}, checkout_url = ${session.url}
       WHERE order_id = ${orderId} AND status = 'CREATING'
      RETURNING order_id
    `.execute(trx);
    return rows.length === 1;
  }

  async lockOrder(trx: Transaction<DB>, orderId: string): Promise<LockedOrderRecord | null> {
    const order = await lockOrder(trx, orderId);
    if (order === null) return null;
    const payment = await trx
      .selectFrom('commerce.payments')
      .select(['status', 'checkoutSessionId'])
      .where('orderId', '=', orderId)
      .executeTakeFirst();
    return {
      orderId: order.id,
      userId: order.userId,
      status: order.status as OrderStatus,
      totalAmount: order.totalAmount,
      currency: order.currency,
      paymentStatus: (payment?.status as PaymentStatus | undefined) ?? null,
      checkoutSessionId: payment?.checkoutSessionId ?? null,
    };
  }

  findOwner(orderId: string, ex: Executor = this.db): Promise<string | null> {
    return findOrderOwner(ex, orderId);
  }

  async findOrderIdBySession(sessionId: string, ex: Executor = this.db): Promise<string | null> {
    const row = await ex
      .selectFrom('commerce.payments')
      .select('orderId')
      .where('checkoutSessionId', '=', sessionId)
      .executeTakeFirst();
    return row?.orderId ?? null;
  }

  async findOrderIdByPaymentIntent(
    paymentIntentId: string,
    ex: Executor = this.db,
  ): Promise<string | null> {
    const row = await ex
      .selectFrom('commerce.payments')
      .select('orderId')
      .where('paymentIntentId', '=', paymentIntentId)
      .executeTakeFirst();
    return row?.orderId ?? null;
  }

  async markPaid(trx: Transaction<DB>, input: MarkPaidInput): Promise<MarkPaidResult> {
    const result = await markOrderPaid(trx, input);
    switch (result.outcome) {
      case 'NOT_FOUND':
        return result;
      case 'DUPLICATE_EFFECT':
        return { outcome: 'DUPLICATE_EFFECT', userId: result.userId, status: result.status };
      case 'MISMATCH':
        return {
          outcome: 'MISMATCH',
          userId: result.userId,
          previousStatus: result.previousStatus,
        };
      case 'APPLIED':
        return {
          outcome: 'APPLIED',
          userId: result.userId,
          previousStatus: result.previousStatus,
          paidAt: result.paidAt,
          lines: result.lines.map((l) => ({
            id: l.id,
            courseId: l.courseId,
            finalAmount: l.finalAmount,
          })),
        };
    }
  }

  async closeOrder(trx: Transaction<DB>, input: CloseOrderInput): Promise<Date> {
    const payment = await sql<{ status: PaymentStatus }>`
      UPDATE commerce.payments
         SET status = CASE WHEN status = 'OPEN' THEN 'EXPIRED' ELSE 'ABANDONED' END,
             checkout_url = NULL,
             checkout_session_id = coalesce(checkout_session_id, ${input.abandonedSessionId ?? null})
       WHERE order_id = ${input.orderId}
         AND status IN (${input.toStatus === 'EXPIRED' ? sql`'OPEN'` : sql`'OPEN','CREATING'`})
      RETURNING status
    `.execute(trx);
    if (payment.rows.length !== 1) {
      throw new Error(`order ${input.orderId}: no payment that can become ${input.toStatus}`);
    }
    const { rows } = await sql<{ closedAt: Date }>`
      UPDATE commerce.orders SET status = ${input.toStatus}, closed_at = now()
       WHERE id = ${input.orderId} AND status = 'PENDING_PAYMENT'
      RETURNING closed_at
    `.execute(trx);
    const closed = rows[0];
    if (closed === undefined) {
      throw new Error(`order ${input.orderId} is not PENDING_PAYMENT`);
    }
    await appendOrderTransition(trx, {
      orderId: input.orderId,
      toStatus: input.toStatus,
      cause: input.cause,
      actorId: input.actorId,
      providerEventId: input.providerEventId,
    });
    await releaseCouponRedemptions(trx, input.orderId);
    return closed.closedAt;
  }

  async findHeader(orderId: string, ex: Executor = this.db): Promise<OrderHeaderRecord | null> {
    const { rows } = await sql<HeaderRow>`
      SELECT id, order_number, user_id, status, currency, total_amount, placed_at, paid_at, closed_at
        FROM commerce.orders WHERE id = ${orderId}
    `.execute(ex);
    const row = rows[0];
    return row === undefined ? null : toHeader(row);
  }

  async findPaidLines(orderId: string, ex: Executor): Promise<PaidOrderLineRecord[]> {
    const { rows } = await sql<PaidOrderLineRecord>`
      SELECT l.id AS order_line_id, l.course_id, l.instructor_id, l.course_title, l.list_amount,
             l.discount_amount, l.final_amount, l.coupon_id, c.code AS coupon_code,
             l.revenue_share_bps, l.instructor_share_amount, l.platform_share_amount
        FROM commerce.order_lines l
        LEFT JOIN commerce.coupons c ON c.id = l.coupon_id
       WHERE l.order_id = ${orderId}
       ORDER BY l.line_no
    `.execute(ex);
    return rows;
  }

  async insertDuplicatePurchaseRefund(
    trx: Transaction<DB>,
    input: { orderId: string; orderLineId: string; userId: string; amount: string },
  ): Promise<{ refundId: string; approvedAt: Date }> {
    const { rows } = await sql<{ id: string; approvedAt: Date }>`
      INSERT INTO commerce.refunds
        (order_id, order_line_id, user_id, amount, status, initiated_by, reason_code, approved_at)
      VALUES (${input.orderId}, ${input.orderLineId}, ${input.userId}, ${input.amount}::numeric,
              'APPROVED', 'SYSTEM', 'DUPLICATE_PURCHASE', now())
      RETURNING id, approved_at
    `.execute(trx);
    const refund = rows[0];
    if (refund === undefined) throw new Error('refund insert returned nothing');
    await sql`
      INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status)
      VALUES (${refund.id}, 1, NULL, 'APPROVED')
    `.execute(trx);
    return { refundId: refund.id, approvedAt: refund.approvedAt };
  }

  async removePurchasedFromCart(
    trx: Transaction<DB>,
    input: { userId: string; orderId: string; courseIds: readonly string[] },
  ): Promise<void> {
    if (input.courseIds.length > 0) {
      await sql`
        DELETE FROM commerce.cart_items
         WHERE user_id = ${input.userId} AND course_id = ANY(${[...input.courseIds]}::uuid[])
      `.execute(trx);
    }
    await sql`
      UPDATE commerce.carts k SET coupon_code = NULL
       WHERE k.user_id = ${input.userId}
         AND k.coupon_code IN (SELECT c.code
                                 FROM commerce.coupon_redemptions r
                                 JOIN commerce.coupons c ON c.id = r.coupon_id
                                WHERE r.order_id = ${input.orderId} AND r.status = 'CONSUMED')
    `.execute(trx);
  }

  async listForUser(
    userId: string,
    page: { after?: OrderKeyset; limit: number },
    ex: Executor = this.db,
  ): Promise<OrderSummaryRecord[]> {
    const after =
      page.after === undefined
        ? sql``
        : sql`AND (o.placed_at, o.id) < (${page.after.placedAt}::timestamptz, ${page.after.id}::uuid)`;
    const { rows } = await sql<{
      id: string;
      orderNumber: string;
      status: OrderStatus;
      currency: string;
      totalAmount: string;
      placedAt: Date;
      placedAtText: string;
      paidAt: Date | null;
      lineCount: number;
      courseTitles: string[];
    }>`
      SELECT o.id, o.order_number, o.status, o.currency, o.total_amount, o.placed_at,
             to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS placed_at_text,
             o.paid_at, t.line_count, t.course_titles
        FROM commerce.orders o
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS line_count,
                 coalesce(array_agg(l.course_title ORDER BY l.line_no), '{}'::text[]) AS course_titles
            FROM commerce.order_lines l WHERE l.order_id = o.id) t
       WHERE o.user_id = ${userId} ${after}
       ORDER BY o.placed_at DESC, o.id DESC
       LIMIT ${page.limit}
    `.execute(ex);
    return rows.map((row) => ({
      id: row.id,
      orderNumber: orderNumberOf(row.orderNumber),
      status: row.status,
      currency: row.currency,
      totalAmount: row.totalAmount,
      lineCount: row.lineCount,
      courseTitles: row.courseTitles,
      placedAt: row.placedAt,
      paidAt: row.paidAt,
      keyset: { placedAt: row.placedAtText, id: row.id },
    }));
  }

  async findDetail(orderId: string, ex: Executor = this.db): Promise<OrderDetailRecord | null> {
    const header = await this.findHeader(orderId, ex);
    if (header === null) return null;
    const { rows: payments } = await sql<{ status: PaymentStatus; checkoutUrl: string | null }>`
      SELECT status, checkout_url FROM commerce.payments WHERE order_id = ${orderId}
    `.execute(ex);
    const { rows: refunded } = await sql<{ amount: string }>`
      SELECT coalesce(sum(amount), 0)::numeric(12,2) AS amount
        FROM commerce.refunds WHERE order_id = ${orderId} AND status = 'SUCCEEDED'
    `.execute(ex);
    const { rows: lines } = await sql<{
      id: string;
      lineNo: number;
      courseId: string;
      courseTitle: string;
      instructorId: string;
      listAmount: string;
      discountAmount: string;
      finalAmount: string;
      couponCode: string | null;
      refundId: string | null;
      refundStatus: RefundStatus | null;
    }>`
      SELECT l.id, l.line_no, l.course_id, l.course_title, l.instructor_id, l.list_amount,
             l.discount_amount, l.final_amount, c.code AS coupon_code,
             r.id AS refund_id, r.status AS refund_status
        FROM commerce.order_lines l
        LEFT JOIN commerce.coupons c ON c.id = l.coupon_id
        LEFT JOIN LATERAL (SELECT id, status FROM commerce.refunds
                            WHERE order_line_id = l.id
                            ORDER BY created_at DESC, id DESC LIMIT 1) r ON true
       WHERE l.order_id = ${orderId}
       ORDER BY l.line_no
    `.execute(ex);
    const payment = payments[0];
    return {
      ...header,
      payment:
        payment === undefined ? null : { status: payment.status, checkoutUrl: payment.checkoutUrl },
      refundedAmount: refunded[0]?.amount ?? '0.00',
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        courseId: l.courseId,
        courseTitle: l.courseTitle,
        instructorId: l.instructorId,
        listAmount: l.listAmount,
        discountAmount: l.discountAmount,
        finalAmount: l.finalAmount,
        couponCode: l.couponCode,
        latestRefund:
          l.refundId === null || l.refundStatus === null
            ? null
            : { id: l.refundId, status: l.refundStatus },
      })),
    };
  }
}
