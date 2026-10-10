/**
 * Quote inputs (docs/phase-4-schema-design.md §8.1), for GetCart and for checkout after the
 * coupon locks (§8.2). The database is the discount rounding authority
 * (`commerce.coupon_discount`); catalog status/owner/title and active enrollments come from the
 * facades, and turning candidates into coupon_expired / not_started / exhausted / already_used /
 * invalid is the use case's job (T13).
 */
import { sql } from 'kysely';
import { type Executor, requireTransaction } from '../transaction';

export interface QuoteLine {
  courseId: string;
  addedAt: Date;
  /** null = the course has no price row (not for sale, D16). */
  listAmount: string | null;
  currency: string | null;
  /** Best applicable coupon for this line (highest discount, tie -> course coupon, then id). */
  couponId: string | null;
  discountAmount: string;
  /** list - discount; null when there is no price. */
  finalAmount: string | null;
}

/** Derived coupon state at the statement's `now()`. */
export type CouponState = 'SCHEDULED' | 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'DEACTIVATED';

export interface CouponCandidate {
  id: string;
  scope: string;
  courseId: string | null;
  discountType: string;
  percentOff: number | null;
  amountOff: string | null;
  currency: string | null;
  startsAt: Date;
  endsAt: Date;
  maxRedemptions: number | null;
  /** RESERVED + CONSUMED redemptions (int8 -> string). */
  usedCount: string;
  usedByMe: boolean;
  state: CouponState;
}

export interface CartQuote {
  /** Cart order: added_at, course_id. */
  lines: QuoteLine[];
  /** Coupons whose code equals the cart's coupon code, for cart courses or the platform. */
  candidates: CouponCandidate[];
}

/**
 * Both statements run against the same rows; inside checkout call it in the transaction that
 * holds the cart and coupon locks (READ COMMITTED: a fresh snapshot after the locks).
 */
export async function quoteCart(executor: Executor, userId: string): Promise<CartQuote> {
  const { rows: lines } = await sql<QuoteLine>`
    WITH cart AS (
      SELECT k.coupon_code FROM commerce.carts k WHERE k.user_id = ${userId}),
    lines AS (
      SELECT ci.course_id, ci.added_at, p.amount AS list_amount, p.currency
        FROM commerce.cart_items ci
        LEFT JOIN commerce.course_prices p ON p.course_id = ci.course_id
       WHERE ci.user_id = ${userId}),
    cands AS (
      SELECT c.id, c.scope, c.course_id, c.discount_type, c.percent_off, c.amount_off, c.currency,
             c.starts_at, c.ends_at, c.deactivated_at, c.max_redemptions,
             (SELECT count(*) FROM commerce.coupon_redemptions r
               WHERE r.coupon_id = c.id AND r.status IN ('RESERVED','CONSUMED'))                          AS used_count,
             EXISTS (SELECT 1 FROM commerce.coupon_redemptions r
                      WHERE r.coupon_id = c.id AND r.user_id = ${userId} AND r.status IN ('RESERVED','CONSUMED')) AS used_by_me
        FROM commerce.coupons c, cart
       WHERE c.code = cart.coupon_code
         AND (c.course_id IN (SELECT course_id FROM lines) OR c.course_id IS NULL))
    SELECT l.course_id, l.added_at, l.list_amount, l.currency, b.coupon_id,
           coalesce(b.discount_amount, 0)::numeric(12,2)                 AS discount_amount,
           (l.list_amount - coalesce(b.discount_amount, 0))::numeric(12,2) AS final_amount
      FROM lines l
      LEFT JOIN LATERAL (
        SELECT c.id AS coupon_id,
               commerce.coupon_discount(l.list_amount, c.discount_type, c.percent_off, c.amount_off) AS discount_amount
          FROM cands c
         WHERE (c.course_id = l.course_id OR c.course_id IS NULL)
           AND c.deactivated_at IS NULL AND now() >= c.starts_at AND now() < c.ends_at
           AND (c.max_redemptions IS NULL OR c.used_count < c.max_redemptions)
           AND NOT c.used_by_me
           AND (c.currency IS NULL OR c.currency = l.currency)
         ORDER BY discount_amount DESC, (c.scope = 'COURSE') DESC, c.id
         LIMIT 1) b ON l.list_amount > 0
     ORDER BY l.added_at, l.course_id
  `.execute(executor);
  const { rows: candidates } = await sql<CouponCandidate>`
    WITH cart AS (
      SELECT k.coupon_code FROM commerce.carts k WHERE k.user_id = ${userId})
    SELECT c.id, c.scope, c.course_id, c.discount_type, c.percent_off, c.amount_off, c.currency,
           c.starts_at, c.ends_at, c.max_redemptions, u.used_count, u.used_by_me,
           CASE WHEN c.deactivated_at IS NOT NULL THEN 'DEACTIVATED'
                WHEN now() < c.starts_at          THEN 'SCHEDULED'
                WHEN now() >= c.ends_at           THEN 'EXPIRED'
                WHEN c.max_redemptions IS NOT NULL AND u.used_count >= c.max_redemptions THEN 'EXHAUSTED'
                ELSE 'ACTIVE' END AS state
      FROM commerce.coupons c
      JOIN cart ON c.code = cart.coupon_code
      CROSS JOIN LATERAL (
        SELECT count(*) AS used_count,
               coalesce(bool_or(r.user_id = ${userId}), false) AS used_by_me
          FROM commerce.coupon_redemptions r
         WHERE r.coupon_id = c.id AND r.status IN ('RESERVED','CONSUMED')) u
     WHERE c.course_id IN (SELECT ci.course_id FROM commerce.cart_items ci WHERE ci.user_id = ${userId})
        OR c.course_id IS NULL
     ORDER BY c.id
  `.execute(executor);
  return { lines, candidates };
}

/**
 * Checkout lock step (after the cart and before re-quoting): locks the coupons with this code for
 * the cart's courses or the platform, ascending id, FOR NO KEY UPDATE (conflicts with
 * DeactivateCoupon's UPDATE and with the reservation trigger). Returns the locked ids.
 */
export async function lockCheckoutCoupons(
  executor: Executor,
  code: string,
  courseIds: readonly string[],
): Promise<string[]> {
  const trx = requireTransaction(executor, 'lockCheckoutCoupons');
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM commerce.coupons
     WHERE code = ${code} AND (course_id = ANY(${[...courseIds]}::uuid[]) OR course_id IS NULL)
     ORDER BY id FOR NO KEY UPDATE
  `.execute(trx);
  return rows.map((r) => r.id);
}
