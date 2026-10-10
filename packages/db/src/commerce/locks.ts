/**
 * Commerce row locks and job locks (docs/phase-4-schema-design.md §6 R8, §8.2–§8.5).
 *
 * Lock order (final; a path may skip a step but never takes an earlier step after a later one):
 *   carts -> orders -> payments -> refunds -> coupons (ascending id) -> coupon_redemptions
 *   -> enrollments (ascending course_id)
 * Every commerce transaction runs at READ COMMITTED (the default).
 */
import { sql } from 'kysely';
import { type Executor, requireTransaction } from '../transaction';

/** `pg_try_advisory_xact_lock` key of the API refund dispatcher (`0x75646d79_03`, §6 item 7). */
export const REFUND_DISPATCH_LOCK_KEY = 0x75646d79_03;
/** `pg_try_advisory_xact_lock` key of the API reconciler (`0x75646d79_04`, §6 item 7). */
export const COMMERCE_RECONCILE_LOCK_KEY = 0x75646d79_04;

/** Takes a transaction-scoped advisory lock without waiting; false = another replica holds it. */
export async function tryAdvisoryXactLock(executor: Executor, key: number): Promise<boolean> {
  const trx = requireTransaction(executor, 'tryAdvisoryXactLock');
  const { rows } = await sql<{ locked: boolean }>`
    SELECT pg_try_advisory_xact_lock(${key}::bigint) AS locked
  `.execute(trx);
  return rows[0]?.locked === true;
}

/**
 * Lock step 1, the per-user commerce mutex: creates the cart row if needed and locks it
 * FOR UPDATE. Checkout, the PAID transition, cancel and RequestRefund (D11 abuse count, R5) all
 * take it first. Returns the cart's coupon code.
 */
export async function lockUserCart(
  executor: Executor,
  userId: string,
): Promise<{ couponCode: string | null }> {
  const trx = requireTransaction(executor, 'lockUserCart');
  await sql`INSERT INTO commerce.carts (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`.execute(
    trx,
  );
  const { rows } = await sql<{ couponCode: string | null }>`
    SELECT coupon_code FROM commerce.carts WHERE user_id = ${userId} FOR UPDATE
  `.execute(trx);
  return { couponCode: rows[0]?.couponCode ?? null };
}

export interface LockedOrder {
  id: string;
  userId: string;
  status: string;
  totalAmount: string;
  currency: string;
  paidAt: Date | null;
}

/** Lock step 2: the order row FOR UPDATE (after the cart). null = no such order. */
export async function lockOrder(executor: Executor, orderId: string): Promise<LockedOrder | null> {
  const trx = requireTransaction(executor, 'lockOrder');
  const { rows } = await sql<LockedOrder>`
    SELECT id, user_id, status, total_amount, currency, paid_at
      FROM commerce.orders WHERE id = ${orderId} FOR UPDATE
  `.execute(trx);
  return rows[0] ?? null;
}

/** `orders.user_id` without a lock (it is immutable): webhook handlers map the order first. */
export async function findOrderOwner(executor: Executor, orderId: string): Promise<string | null> {
  const { rows } = await sql<{ userId: string }>`
    SELECT user_id FROM commerce.orders WHERE id = ${orderId}
  `.execute(executor);
  return rows[0]?.userId ?? null;
}
