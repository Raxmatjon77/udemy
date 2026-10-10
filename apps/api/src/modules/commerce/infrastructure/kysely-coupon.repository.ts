import { Injectable } from '@nestjs/common';
import type { CouponDiscountType, CouponScope, CouponState } from '@udemy/contracts';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type CouponRecord,
  CouponRepository,
  type CouponScopeFilter,
  type NewCoupon,
} from '../application/ports/coupon.repository';
import { mapCommerceConstraints } from './commerce-constraint-errors';

interface CouponRow {
  id: string;
  scope: string;
  courseId: string | null;
  code: string;
  discountType: string;
  percentOff: number | null;
  amountOff: string | null;
  currency: string | null;
  startsAt: Date;
  endsAt: Date;
  maxRedemptions: number | null;
  state: string;
  /** int8 -> string */
  reserved: string;
  consumed: string;
  createdBy: string;
  createdAt: Date;
  deactivatedAt: Date | null;
}

function toRecord(row: CouponRow): CouponRecord {
  return {
    ...row,
    scope: row.scope as CouponScope,
    discountType: row.discountType as CouponDiscountType,
    state: row.state as CouponState,
    reserved: Number(row.reserved),
    consumed: Number(row.consumed),
  };
}

function scopeCondition(filter: CouponScopeFilter) {
  return filter.scope === 'COURSE'
    ? sql`c.scope = 'COURSE' AND c.course_id = ${filter.courseId}`
    : sql`c.scope = 'PLATFORM' AND c.course_id IS NULL`;
}

/**
 * Coupons with the derived state of design §4 (the same CASE as `quoteCart`'s candidates, at
 * the statement's `now()`) and the redemption counts (RESERVED / CONSUMED; RELEASED ones are
 * not counted, D7).
 */
const SELECT_COUPONS = sql`
  SELECT c.id, c.scope, c.course_id, c.code, c.discount_type, c.percent_off, c.amount_off,
         c.currency, c.starts_at, c.ends_at, c.max_redemptions, c.created_by, c.created_at,
         c.deactivated_at, r.reserved, r.consumed,
         CASE WHEN c.deactivated_at IS NOT NULL THEN 'DEACTIVATED'
              WHEN now() < c.starts_at          THEN 'SCHEDULED'
              WHEN now() >= c.ends_at           THEN 'EXPIRED'
              WHEN c.max_redemptions IS NOT NULL
               AND r.reserved + r.consumed >= c.max_redemptions THEN 'EXHAUSTED'
              ELSE 'ACTIVE' END AS state
    FROM commerce.coupons c
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE x.status = 'RESERVED') AS reserved,
             count(*) FILTER (WHERE x.status = 'CONSUMED') AS consumed
        FROM commerce.coupon_redemptions x
       WHERE x.coupon_id = c.id AND x.status IN ('RESERVED','CONSUMED')) r`;

@Injectable()
export class KyselyCouponRepository extends CouponRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async countActiveForCourse(trx: Transaction<DB>, courseId: string): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM commerce.coupons
       WHERE course_id = ${courseId} AND deactivated_at IS NULL AND ends_at > now()
    `.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }

  insert(trx: Transaction<DB>, coupon: NewCoupon): Promise<string> {
    return mapCommerceConstraints(async () => {
      const row = await trx
        .insertInto('commerce.coupons')
        .values({
          scope: coupon.scope,
          courseId: coupon.courseId,
          code: coupon.code,
          discountType: coupon.discountType,
          percentOff: coupon.percentOff,
          amountOff: coupon.amountOff,
          currency: coupon.currency,
          startsAt: coupon.startsAt,
          endsAt: coupon.endsAt,
          maxRedemptions: coupon.maxRedemptions,
          createdBy: coupon.createdBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  async findById(
    couponId: string,
    filter: CouponScopeFilter,
    ex: Executor = this.db,
  ): Promise<CouponRecord | null> {
    const { rows } = await sql<CouponRow>`
      ${SELECT_COUPONS}
       WHERE c.id = ${couponId} AND ${scopeCondition(filter)}
    `.execute(ex);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    filter: CouponScopeFilter,
    page: { readonly afterId?: string; readonly limit: number },
    ex: Executor = this.db,
  ): Promise<CouponRecord[]> {
    const after = page.afterId === undefined ? sql`true` : sql`c.id < ${page.afterId}`;
    const { rows } = await sql<CouponRow>`
      ${SELECT_COUPONS}
       WHERE ${scopeCondition(filter)} AND ${after}
       ORDER BY c.id DESC
       LIMIT ${page.limit}
    `.execute(ex);
    return rows.map(toRecord);
  }

  deactivate(
    trx: Transaction<DB>,
    couponId: string,
    filter: CouponScopeFilter,
    actorId: string,
  ): Promise<boolean> {
    return mapCommerceConstraints(async () => {
      const { rows } = await sql<{ id: string }>`
        UPDATE commerce.coupons c
           SET deactivated_at = now(), deactivated_by = ${actorId}
         WHERE c.id = ${couponId} AND ${scopeCondition(filter)} AND c.deactivated_at IS NULL
        RETURNING c.id
      `.execute(trx);
      return rows.length > 0;
    });
  }
}
