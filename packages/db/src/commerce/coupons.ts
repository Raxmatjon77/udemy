/**
 * Coupon redemption lifecycle (docs/phase-4-schema-design.md D7, §8.2–§8.4).
 *
 * RESERVED at checkout -> CONSUMED at PAID / RELEASED at EXPIRED or CANCELED; RELEASED ->
 * CONSUMED on a late payment (kept `released_at` marks the accepted overshoot). Validity and the
 * `max_redemptions` limit are enforced by `coupon_redemptions_reserve_trg` under the coupon row
 * lock, so `reserveCouponRedemption` is race-free even without the caller's pre-lock; errors
 * (§9): coupon_redemptions_limit_ck / _coupon_valid_ck (23514),
 * coupon_redemptions_coupon_id_user_id_active_uq (23505).
 */
import { sql } from 'kysely';
import { type Executor, requireTransaction } from '../transaction';

export interface ReserveCouponInput {
  orderId: string;
  couponId: string;
  /** Must equal orders.user_id (coupon_redemptions_order_id_user_id_fk). */
  userId: string;
  /** Zero-total order: born CONSUMED (the order is born PAID). */
  consumed?: boolean;
}

/** One row per distinct coupon used by the order; insert it before the order lines that use it. */
export async function reserveCouponRedemption(
  executor: Executor,
  input: ReserveCouponInput,
): Promise<void> {
  const trx = requireTransaction(executor, 'reserveCouponRedemption');
  const consumed = input.consumed === true;
  await sql`
    INSERT INTO commerce.coupon_redemptions (order_id, coupon_id, user_id, status, consumed_at)
    VALUES (${input.orderId}, ${input.couponId}, ${input.userId},
            ${consumed ? 'CONSUMED' : 'RESERVED'}, ${consumed ? sql`now()` : null})
  `.execute(trx);
}

/** PAID: RESERVED or RELEASED -> CONSUMED. Returns the number of redemptions consumed. */
export async function consumeCouponRedemptions(
  executor: Executor,
  orderId: string,
): Promise<number> {
  const result = await sql`
    UPDATE commerce.coupon_redemptions SET status = 'CONSUMED', consumed_at = now()
     WHERE order_id = ${orderId} AND status IN ('RESERVED','RELEASED')
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0);
}

/**
 * EXPIRED / CANCELED, and PAYMENT_REVIEW -> REFUNDED: RESERVED -> RELEASED. Returns the number of
 * redemptions released (idempotent: 0 on a repeat).
 */
export async function releaseCouponRedemptions(
  executor: Executor,
  orderId: string,
): Promise<number> {
  const result = await sql`
    UPDATE commerce.coupon_redemptions SET status = 'RELEASED', released_at = now()
     WHERE order_id = ${orderId} AND status = 'RESERVED'
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0);
}
