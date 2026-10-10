/**
 * Order transitions (docs/phase-4-schema-design.md §8.3, §6 R2–R4).
 *
 * The transition log is linear: the next row is `max(seq) + 1` with `from_status` = the head's
 * `to_status`, inserted under the order row lock (`order_transitions_pk` + the chain FK reject
 * anything else). `orders.status/paid_at/closed_at` must equal the log at COMMIT
 * (orders_status_log_ck), so they are always written in the same transaction, with SQL `now()`.
 */
import { sql } from 'kysely';
import { assertCurrency, assertMoney, assertNonEmptyText } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';
import { consumeCouponRedemptions } from './coupons';
import { findOrderOwner, lockOrder, lockUserCart } from './locks';

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PAYMENT_REVIEW'
  | 'EXPIRED'
  | 'CANCELED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export type OrderTransitionCause =
  'CHECKOUT' | 'ZERO_TOTAL' | 'PROVIDER_EVENT' | 'USER_CANCEL' | 'RECONCILER' | 'REFUND' | 'ADMIN';

export interface AppendOrderTransitionInput {
  orderId: string;
  toStatus: OrderStatus;
  cause: OrderTransitionCause;
  /** Claimed provider_events.event_id (provider 'STRIPE'); required for PROVIDER_EVENT. */
  providerEventId?: string | null;
  /** Required for CHECKOUT / ZERO_TOTAL / USER_CANCEL (the buyer) and ADMIN; NULL otherwise. */
  actorId?: string | null;
  /** ADMIN: >= 10 characters. */
  reason?: string | null;
}

/**
 * Appends the next transition (seq 1 with from_status NULL when the order has none). Call it
 * under the order row lock, after updating `orders`. Returns the new seq.
 */
export async function appendOrderTransition(
  executor: Executor,
  input: AppendOrderTransitionInput,
): Promise<number> {
  const trx = requireTransaction(executor, 'appendOrderTransition');
  const eventId = input.providerEventId ?? null;
  const { rows } = await sql<{ seq: number }>`
    INSERT INTO commerce.order_transitions
      (order_id, seq, from_status, to_status, cause, provider, provider_event_id, actor_id, reason)
    SELECT ${input.orderId}, coalesce(h.seq, 0) + 1, h.to_status, ${input.toStatus}, ${input.cause},
           ${eventId === null ? null : 'STRIPE'}, ${eventId}, ${input.actorId ?? null}, ${input.reason ?? null}
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (SELECT seq, to_status FROM commerce.order_transitions
                          WHERE order_id = ${input.orderId} ORDER BY seq DESC LIMIT 1) h ON true
    RETURNING seq
  `.execute(trx);
  return rows[0]!.seq;
}

export interface PaidOrderLine {
  id: string;
  courseId: string;
  instructorId: string;
  finalAmount: string;
  instructorShareAmount: string;
  platformShareAmount: string;
}

export interface MarkOrderPaidInput {
  orderId: string;
  cause: 'PROVIDER_EVENT' | 'RECONCILER';
  /** The provider_events row claimed in this transaction (real or `reconcile:...`). */
  providerEventId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  /** The provider's amount_total as a decimal string, and its currency (upper case). */
  receivedAmount: string;
  receivedCurrency: string;
}

export type MarkOrderPaidResult =
  | { outcome: 'NOT_FOUND' }
  /** Already PAID / PAYMENT_REVIEW / PARTIALLY_REFUNDED / REFUNDED: no effect. */
  | { outcome: 'DUPLICATE_EFFECT'; userId: string; status: OrderStatus }
  /** PAID; the caller now grants per line (ascending course_id), cleans the cart, writes the outbox. */
  | {
      outcome: 'APPLIED';
      userId: string;
      previousStatus: OrderStatus;
      paidAt: Date;
      lines: PaidOrderLine[];
      consumedCoupons: number;
    }
  /** Amount/currency mismatch: PAYMENT_REVIEW, no grants, redemptions untouched. */
  | { outcome: 'MISMATCH'; userId: string; previousStatus: OrderStatus };

/**
 * §8.3 steps 1–5 of the webhook `checkout.session.completed` (the reconciler uses the same code):
 * cart lock -> order lock -> payment SUCCEEDED -> order PAID (or PAYMENT_REVIEW on a received
 * mismatch) + transition -> redemptions CONSUMED. Concurrent calls for one order serialise on the
 * cart and order locks; the second sees PAID and returns DUPLICATE_EFFECT. Grants, the duplicate
 * refund, cart cleanup, outbox and the provider event outcome are the caller's (steps 6–9).
 */
export async function markOrderPaid(
  executor: Executor,
  input: MarkOrderPaidInput,
): Promise<MarkOrderPaidResult> {
  const trx = requireTransaction(executor, 'markOrderPaid');
  assertMoney('receivedAmount', input.receivedAmount);
  assertCurrency('receivedCurrency', input.receivedCurrency);
  assertNonEmptyText('checkoutSessionId', input.checkoutSessionId, 255);
  assertNonEmptyText('paymentIntentId', input.paymentIntentId, 255);

  const userId = await findOrderOwner(trx, input.orderId);
  if (userId === null) return { outcome: 'NOT_FOUND' };
  await lockUserCart(trx, userId);
  const order = await lockOrder(trx, input.orderId);
  if (order === null) return { outcome: 'NOT_FOUND' };
  const previousStatus = order.status as OrderStatus;
  if (!['PENDING_PAYMENT', 'EXPIRED', 'CANCELED'].includes(previousStatus)) {
    return { outcome: 'DUPLICATE_EFFECT', userId, status: previousStatus };
  }
  const { rows: matchRows } = await sql<{ matches: boolean }>`
    SELECT (${input.receivedAmount}::numeric = ${order.totalAmount}::numeric
            AND ${input.receivedCurrency} = ${order.currency}) AS matches
  `.execute(trx);
  const matches = matchRows[0]?.matches === true;

  const payment = await sql`
    UPDATE commerce.payments
       SET status = 'SUCCEEDED', checkout_session_id = coalesce(checkout_session_id, ${input.checkoutSessionId}),
           checkout_url = NULL, payment_intent_id = ${input.paymentIntentId},
           received_amount = ${input.receivedAmount}::numeric, received_currency = ${input.receivedCurrency},
           succeeded_at = now()
     WHERE order_id = ${input.orderId} AND status IN ('CREATING','OPEN','EXPIRED','ABANDONED')
  `.execute(trx);
  if (Number(payment.numAffectedRows ?? 0) !== 1) {
    // Impossible while payments_order_status_ck holds (an open/closed order has an unsettled payment).
    throw new Error(`order ${input.orderId} (${previousStatus}) has no payment to settle`);
  }

  if (!matches) {
    await sql`
      UPDATE commerce.orders SET status = 'PAYMENT_REVIEW'
       WHERE id = ${input.orderId} AND status IN ('PENDING_PAYMENT','EXPIRED','CANCELED')
    `.execute(trx);
    await appendOrderTransition(trx, {
      orderId: input.orderId,
      toStatus: 'PAYMENT_REVIEW',
      cause: input.cause,
      providerEventId: input.providerEventId,
    });
    return { outcome: 'MISMATCH', userId, previousStatus };
  }

  const { rows: paid } = await sql<{ paidAt: Date }>`
    UPDATE commerce.orders SET status = 'PAID', paid_at = now()
     WHERE id = ${input.orderId} AND status IN ('PENDING_PAYMENT','EXPIRED','CANCELED')
    RETURNING paid_at
  `.execute(trx);
  await appendOrderTransition(trx, {
    orderId: input.orderId,
    toStatus: 'PAID',
    cause: input.cause,
    providerEventId: input.providerEventId,
  });
  const consumedCoupons = await consumeCouponRedemptions(trx, input.orderId);
  const { rows: lines } = await sql<PaidOrderLine>`
    SELECT id, course_id, instructor_id, final_amount, instructor_share_amount, platform_share_amount
      FROM commerce.order_lines WHERE order_id = ${input.orderId}
     ORDER BY course_id
  `.execute(trx);
  return {
    outcome: 'APPLIED',
    userId,
    previousStatus,
    paidAt: paid[0]!.paidAt,
    lines,
    consumedCoupons,
  };
}
