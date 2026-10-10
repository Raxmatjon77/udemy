/**
 * Refund dispatch (docs/phase-4-schema-design.md D9/D11, §8.4, §8.4b, §6 R3).
 *
 * tx1 `leaseRefundsForDispatch`: advisory lock `_03`, then APPROVED refunds with no (or a stale)
 * lease, `FOR UPDATE SKIP LOCKED`, stamped with `dispatch_started_at`; commits at once. The
 * provider call happens with no transaction open (idempotency key `refund:{id}:{attempt}`).
 * tx2 `completeRefundDispatch` / `failRefundDispatch`: order lock, then the refund update fenced
 * on (status APPROVED, attempt, dispatch_started_at); 0 rows = the webhook won, a no-op. A
 * SUCCEEDED refund recomputes the order status in the same transaction (orders_refund_status_ck
 * is checked at COMMIT).
 *
 * The fence compares `dispatch_started_at` with the exact text returned by the lease (a JS Date
 * keeps only milliseconds).
 */
import { sql } from 'kysely';
import { assertBatchSize, assertIntInRange, assertNonEmptyText } from '../internal/assert';
import { type Executor, inTransaction, requireTransaction } from '../transaction';
import { releaseCouponRedemptions } from './coupons';
import { REFUND_DISPATCH_LOCK_KEY, lockOrder, tryAdvisoryXactLock } from './locks';
import { appendOrderTransition, type OrderStatus } from './orders';

export interface LeasedRefund {
  id: string;
  orderId: string;
  orderLineId: string;
  amount: string;
  attempt: number;
  /** Exact `dispatch_started_at` text: pass it back as the fence. */
  claimedAt: string;
  paymentIntentId: string | null;
}

export interface LeaseRefundsOptions {
  batchSize: number;
  /** A lease older than this is a crashed claim and is taken again (default 120 s). */
  staleLeaseSeconds?: number;
}

export interface LeaseRefundsResult {
  /** false = another replica holds the dispatcher lock; skip this tick. */
  locked: boolean;
  refunds: LeasedRefund[];
}

/**
 * tx1. Pass the root db (it commits its own short transaction) or a transaction you commit
 * immediately afterwards; the lease is only visible to others once committed.
 */
export async function leaseRefundsForDispatch(
  executor: Executor,
  options: LeaseRefundsOptions,
): Promise<LeaseRefundsResult> {
  assertBatchSize(options.batchSize);
  const stale = options.staleLeaseSeconds ?? 120;
  assertIntInRange('staleLeaseSeconds', stale, 1, 86_400);
  return inTransaction(executor, async (trx) => {
    if (!(await tryAdvisoryXactLock(trx, REFUND_DISPATCH_LOCK_KEY))) {
      return { locked: false, refunds: [] };
    }
    const { rows } = await sql<LeasedRefund>`
      WITH next AS (
        SELECT r.id FROM commerce.refunds r
         WHERE r.status = 'APPROVED'
           AND (r.dispatch_started_at IS NULL OR r.dispatch_started_at < now() - make_interval(secs => ${stale}))
         ORDER BY r.approved_at, r.id
         LIMIT ${options.batchSize}
         FOR UPDATE SKIP LOCKED)
      UPDATE commerce.refunds r SET dispatch_started_at = now()
        FROM next WHERE r.id = next.id
      RETURNING r.id, r.order_id, r.order_line_id, r.amount, r.attempt, r.dispatch_started_at::text AS claimed_at,
                (SELECT p.payment_intent_id FROM commerce.payments p WHERE p.order_id = r.order_id) AS payment_intent_id
    `.execute(trx);
    return { locked: true, refunds: rows };
  });
}

export interface RefundFence {
  refundId: string;
  orderId: string;
  attempt: number;
  claimedAt: string;
}

export interface RefundDispatchResult {
  /** false = fence lost (the webhook or another dispatcher already moved the refund). */
  applied: boolean;
  /** The order status after a SUCCEEDED refund (unchanged otherwise). */
  orderStatus?: OrderStatus;
}

async function finishDispatch(
  executor: Executor,
  fence: RefundFence,
  to: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED',
  providerRefundId: string | null,
  failureCode: string | null,
): Promise<RefundDispatchResult> {
  const trx = requireTransaction(executor, 'refund dispatch tx2');
  assertIntInRange('attempt', fence.attempt, 1, 20);
  await lockOrder(trx, fence.orderId);
  const { rows } = await sql<{ id: string }>`
    UPDATE commerce.refunds
       SET status = ${to}, provider_refund_id = ${providerRefundId}, failure_code = ${failureCode},
           succeeded_at = CASE WHEN ${to}::text = 'SUCCEEDED' THEN now() END, dispatch_started_at = NULL
     WHERE id = ${fence.refundId} AND order_id = ${fence.orderId} AND status = 'APPROVED'
       AND attempt = ${fence.attempt} AND dispatch_started_at = ${fence.claimedAt}::timestamptz
    RETURNING id
  `.execute(trx);
  if (rows.length === 0) return { applied: false };
  await sql`
    INSERT INTO commerce.refund_transitions (refund_id, seq, from_status, to_status, provider_refund_id, failure_code)
    SELECT ${fence.refundId}, h.seq + 1, h.to_status, ${to}, ${providerRefundId}, ${failureCode}
      FROM (SELECT seq, to_status FROM commerce.refund_transitions
             WHERE refund_id = ${fence.refundId} ORDER BY seq DESC LIMIT 1) h
  `.execute(trx);
  if (to !== 'SUCCEEDED') return { applied: true };
  return { applied: true, orderStatus: await applySucceededRefundsToOrder(trx, fence.orderId) };
}

/** tx2 after the provider accepted the refund: SUBMITTED (pending) or SUCCEEDED (synchronous). */
export async function completeRefundDispatch(
  executor: Executor,
  input: RefundFence & { status: 'SUBMITTED' | 'SUCCEEDED'; providerRefundId: string },
): Promise<RefundDispatchResult> {
  assertNonEmptyText('providerRefundId', input.providerRefundId, 255);
  return finishDispatch(executor, input, input.status, input.providerRefundId, null);
}

/** tx2 after a definitive provider rejection: FAILED with `failure_code` (^[a-z0-9_]{1,64}$). */
export async function failRefundDispatch(
  executor: Executor,
  input: RefundFence & { failureCode: string },
): Promise<RefundDispatchResult> {
  if (!/^[a-z0-9_]{1,64}$/.test(input.failureCode)) {
    throw new RangeError(`failureCode must match ^[a-z0-9_]{1,64}$, got ${input.failureCode}`);
  }
  return finishDispatch(executor, input, 'FAILED', null, input.failureCode);
}

/** Transient provider error: give the lease back (fenced), so the next tick retries at once. */
export async function releaseRefundDispatchLease(
  executor: Executor,
  input: { refundId: string; claimedAt: string },
): Promise<boolean> {
  const result = await sql`
    UPDATE commerce.refunds SET dispatch_started_at = NULL
     WHERE id = ${input.refundId} AND status = 'APPROVED' AND dispatch_started_at = ${input.claimedAt}::timestamptz
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0) === 1;
}

/**
 * §8.4b, under the order lock (the caller holds it): Σ SUCCEEDED refunds = total -> REFUNDED
 * (PAYMENT_REVIEW -> REFUNDED also releases RESERVED redemptions); PAID with 0 < Σ < total ->
 * PARTIALLY_REFUNDED; otherwise unchanged. Appends the REFUND transition. Returns the status.
 */
export async function applySucceededRefundsToOrder(
  executor: Executor,
  orderId: string,
): Promise<OrderStatus> {
  const trx = requireTransaction(executor, 'applySucceededRefundsToOrder');
  const { rows } = await sql<{ status: OrderStatus; isFull: boolean; isPartial: boolean }>`
    SELECT o.status,
           s.refunded = o.total_amount                          AS is_full,
           s.refunded > 0 AND s.refunded < o.total_amount       AS is_partial
      FROM commerce.orders o
      CROSS JOIN LATERAL (SELECT coalesce(sum(r.amount), 0) AS refunded FROM commerce.refunds r
                           WHERE r.order_id = o.id AND r.status = 'SUCCEEDED') s
     WHERE o.id = ${orderId}
  `.execute(trx);
  const row = rows[0];
  if (row === undefined) throw new Error(`order ${orderId} not found`);
  let next: OrderStatus | null = null;
  if (row.isFull && ['PAID', 'PARTIALLY_REFUNDED', 'PAYMENT_REVIEW'].includes(row.status)) {
    next = 'REFUNDED';
  } else if (row.isPartial && row.status === 'PAID') {
    next = 'PARTIALLY_REFUNDED';
  }
  if (next === null) return row.status;
  await sql`UPDATE commerce.orders SET status = ${next} WHERE id = ${orderId} AND status = ${row.status}`.execute(
    trx,
  );
  await appendOrderTransition(trx, { orderId, toStatus: next, cause: 'REFUND' });
  if (row.status === 'PAYMENT_REVIEW') await releaseCouponRedemptions(trx, orderId);
  return next;
}
