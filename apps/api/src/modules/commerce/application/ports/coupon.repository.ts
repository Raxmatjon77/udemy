import type { CouponDiscountType, CouponScope, CouponState } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';

/** A coupon with its derived state and redemption counts (at the statement's `now()`). */
export interface CouponRecord {
  readonly id: string;
  readonly scope: CouponScope;
  readonly courseId: string | null;
  readonly code: string;
  readonly discountType: CouponDiscountType;
  readonly percentOff: number | null;
  readonly amountOff: string | null;
  readonly currency: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly maxRedemptions: number | null;
  readonly state: CouponState;
  readonly reserved: number;
  readonly consumed: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

/** Coupon ids are always resolved within a scope (§9 IDOR: a foreign course's coupon is 404). */
export type CouponScopeFilter =
  { readonly scope: 'COURSE'; readonly courseId: string } | { readonly scope: 'PLATFORM' };

export interface NewCoupon {
  readonly scope: CouponScope;
  readonly courseId: string | null;
  /** Uppercase (`^[A-Z0-9_-]{4,20}$`). */
  readonly code: string;
  readonly discountType: CouponDiscountType;
  readonly percentOff: number | null;
  readonly amountOff: string | null;
  readonly currency: string | null;
  /** Default ("now"): the transaction's `now()` from `CommerceClock`. */
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly maxRedemptions: number | null;
  readonly createdBy: string;
}

/** `commerce.coupons`: immutable terms, only `deactivated_*` changes, once (D5). */
export abstract class CouponRepository {
  /** Coupons of the course that are not deactivated and not expired (SCHEDULED ones count). */
  abstract countActiveForCourse(trx: Transaction<DB>, courseId: string): Promise<number>;

  /** @throws CouponCodeTaken (409) on `coupons_course_id_code_uq` */
  abstract insert(trx: Transaction<DB>, coupon: NewCoupon): Promise<string>;

  abstract findById(
    couponId: string,
    filter: CouponScopeFilter,
    ex?: Executor,
  ): Promise<CouponRecord | null>;

  /** Newest first (uuidv7 ids are time-ordered): keyset on `id < afterId`. */
  abstract list(
    filter: CouponScopeFilter,
    page: { readonly afterId?: string; readonly limit: number },
    ex?: Executor,
  ): Promise<CouponRecord[]>;

  /**
   * `UPDATE ... SET deactivated_at = now() WHERE id AND scope AND deactivated_at IS NULL`. True
   * when THIS call deactivated it (false: unknown in this scope, or already deactivated).
   */
  abstract deactivate(
    trx: Transaction<DB>,
    couponId: string,
    filter: CouponScopeFilter,
    actorId: string,
  ): Promise<boolean>;
}
