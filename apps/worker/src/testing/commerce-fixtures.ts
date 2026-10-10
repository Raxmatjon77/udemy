import { randomUUID } from 'node:crypto';
import type { EventEnvelope, OrderPaidPayload, RefundSucceededPayload } from '@udemy/contracts';
import { completeRefundDispatch, type DB, type Kysely, sql } from '@udemy/db';
import { createOrder, createRefund, payOrder } from '@udemy/db/testing';

/**
 * Committed commerce rows for worker integration tests, built with the `@udemy/db/testing`
 * commerce fixtures (removed afterwards with `@udemy/db/testing` `deleteTestData`). Each builder
 * runs in ONE transaction, so the api's CommerceJobs (refund dispatcher, reconciler) never see an
 * intermediate PENDING_PAYMENT order or APPROVED refund. Nothing here writes outbox rows: the
 * tests build the events in memory, so a running worker never sees them.
 */

export interface SeedLine {
  readonly instructorId: string;
  readonly listAmount: string;
  readonly courseTitle?: string;
  readonly couponId?: string;
}

export interface SeededLine {
  readonly id: string;
  readonly courseId: string;
  readonly instructorId: string;
  readonly courseTitle: string;
  readonly listAmount: string;
  readonly discountAmount: string;
  readonly finalAmount: string;
  readonly couponId: string | null;
  readonly couponCode: string | null;
  readonly revenueShareBps: number;
  readonly instructorShareAmount: string;
  readonly platformShareAmount: string;
}

export interface SeededOrder {
  readonly orderId: string;
  readonly orderNumber: number;
  readonly userId: string;
  readonly currency: string;
  readonly totalAmount: string;
  readonly paidAt: Date;
  /** In line_no order. */
  readonly lines: readonly SeededLine[];
}

/** Checkout tx A + the webhook PAID transition (markOrderPaid), committed together. */
export async function seedPaidOrder(
  db: Kysely<DB>,
  options: { buyerId: string; lines: readonly SeedLine[] },
): Promise<SeededOrder> {
  return db.transaction().execute(async (trx) => {
    const order = await createOrder(trx, {
      userId: options.buyerId,
      lines: options.lines.map((l) => ({
        instructorId: l.instructorId,
        listAmount: l.listAmount,
        courseTitle: l.courseTitle,
        couponId: l.couponId,
      })),
    });
    if (order.status !== 'PAID') {
      const paid = await payOrder(trx, order);
      if (paid.outcome !== 'APPLIED') throw new Error(`payOrder: ${paid.outcome}`);
    }
    const head = await trx
      .selectFrom('commerce.orders')
      .select(['orderNumber', 'currency', 'totalAmount', 'paidAt'])
      .where('id', '=', order.orderId)
      .executeTakeFirstOrThrow();
    const lines = await trx
      .selectFrom('commerce.orderLines as l')
      .leftJoin('commerce.coupons as c', 'c.id', 'l.couponId')
      .select([
        'l.id',
        'l.courseId',
        'l.instructorId',
        'l.courseTitle',
        'l.listAmount',
        'l.discountAmount',
        'l.finalAmount',
        'l.couponId',
        'c.code as couponCode',
        'l.revenueShareBps',
        'l.instructorShareAmount',
        'l.platformShareAmount',
      ])
      .where('l.orderId', '=', order.orderId)
      .orderBy('l.lineNo')
      .execute();
    if (head.paidAt === null) throw new Error('seedPaidOrder: order is not PAID');
    return {
      orderId: order.orderId,
      orderNumber: Number(head.orderNumber),
      userId: options.buyerId,
      currency: head.currency,
      totalAmount: head.totalAmount,
      paidAt: head.paidAt,
      lines,
    };
  });
}

/** A student refund of the full line amount, left REQUESTED (the NEEDS_REVIEW path). */
export async function seedRequestedRefund(
  db: Kysely<DB>,
  order: SeededOrder,
  line: SeededLine,
): Promise<string> {
  return createRefund(db, {
    orderId: order.orderId,
    orderLineId: line.id,
    userId: order.userId,
    amount: line.finalAmount,
    status: 'REQUESTED',
  });
}

/**
 * An auto-approved refund taken through the dispatcher's tx2 to SUCCEEDED (with the order
 * status recompute), in one transaction. The lease is taken on this refund only (not through
 * `leaseRefundsForDispatch`, which would lease other tests' refunds on the shared database).
 */
export async function seedSucceededRefund(
  db: Kysely<DB>,
  order: SeededOrder,
  line: SeededLine,
): Promise<{ refundId: string; succeededAt: Date }> {
  return db.transaction().execute(async (trx) => {
    const refundId = await createRefund(trx, {
      orderId: order.orderId,
      orderLineId: line.id,
      userId: order.userId,
      amount: line.finalAmount,
    });
    const { rows } = await sql<{ claimedAt: string; attempt: number }>`
      UPDATE commerce.refunds SET dispatch_started_at = now()
       WHERE id = ${refundId} AND status = 'APPROVED'
      RETURNING dispatch_started_at::text AS claimed_at, attempt
    `.execute(trx);
    const lease = rows[0];
    if (lease === undefined) throw new Error('seedSucceededRefund: refund is not APPROVED');
    const done = await completeRefundDispatch(trx, {
      refundId,
      orderId: order.orderId,
      attempt: lease.attempt,
      claimedAt: lease.claimedAt,
      status: 'SUCCEEDED',
      providerRefundId: `re_it_${refundId}`,
    });
    if (!done.applied) throw new Error('seedSucceededRefund: fence lost');
    const refund = await trx
      .selectFrom('commerce.refunds')
      .select('succeededAt')
      .where('id', '=', refundId)
      .executeTakeFirstOrThrow();
    if (refund.succeededAt === null) throw new Error('seedSucceededRefund: not SUCCEEDED');
    return { refundId, succeededAt: refund.succeededAt };
  });
}

/** A `commerce.order` envelope with a fresh event id (key = orderId). */
export function commerceEnvelope(
  eventType: string,
  orderId: string,
  payload: object,
  eventId: string = randomUUID(),
): EventEnvelope {
  return {
    eventId,
    eventType,
    aggregateType: 'commerce.order',
    aggregateId: orderId,
    occurredAt: new Date().toISOString(),
    version: 1,
    payload,
  };
}

/** The `OrderPaid` payload the api writes for this order (lines from the snapshot). */
export function orderPaidPayload(order: SeededOrder): OrderPaidPayload {
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    userId: order.userId,
    currency: order.currency,
    totalAmount: order.totalAmount,
    provider: order.totalAmount === '0.00' ? 'NONE' : 'STRIPE',
    paidAt: order.paidAt.toISOString(),
    lines: order.lines.map((l) => ({
      orderLineId: l.id,
      courseId: l.courseId,
      instructorId: l.instructorId,
      courseTitle: l.courseTitle,
      listAmount: l.listAmount,
      discountAmount: l.discountAmount,
      finalAmount: l.finalAmount,
      couponId: l.couponId,
      couponCode: l.couponCode,
      revenueShareBps: l.revenueShareBps,
      instructorShareAmount: l.instructorShareAmount,
      platformShareAmount: l.platformShareAmount,
    })),
  };
}

/** The `RefundSucceeded` payload for a full-line refund. */
export function refundSucceededPayload(
  order: SeededOrder,
  line: SeededLine,
  refund: { refundId: string; succeededAt: Date },
): RefundSucceededPayload {
  return {
    refundId: refund.refundId,
    orderId: order.orderId,
    orderLineId: line.id,
    userId: order.userId,
    courseId: line.courseId,
    instructorId: line.instructorId,
    currency: order.currency,
    amount: line.finalAmount,
    instructorShareAmount: line.instructorShareAmount,
    platformShareAmount: line.platformShareAmount,
    succeededAt: refund.succeededAt.toISOString(),
  };
}
