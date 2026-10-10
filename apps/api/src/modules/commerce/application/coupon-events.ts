import type { CouponCreatedPayload, CouponDeactivatedPayload } from '@udemy/contracts';
import type { CouponRecord } from './ports/coupon.repository';

/** `CouponCreated` (design §7): the full immutable terms. */
export function couponCreatedPayload(coupon: CouponRecord, actorId: string): CouponCreatedPayload {
  return {
    couponId: coupon.id,
    scope: coupon.scope,
    courseId: coupon.courseId,
    code: coupon.code,
    discountType: coupon.discountType,
    percentOff: coupon.percentOff,
    amountOff: coupon.amountOff,
    currency: coupon.currency,
    startsAt: coupon.startsAt.toISOString(),
    endsAt: coupon.endsAt.toISOString(),
    maxRedemptions: coupon.maxRedemptions,
    actorId,
    createdAt: coupon.createdAt.toISOString(),
  };
}

/** `CouponDeactivated` (design §7). */
export function couponDeactivatedPayload(
  coupon: CouponRecord & { readonly deactivatedAt: Date },
  actorId: string,
): CouponDeactivatedPayload {
  return {
    couponId: coupon.id,
    scope: coupon.scope,
    courseId: coupon.courseId,
    code: coupon.code,
    actorId,
    deactivatedAt: coupon.deactivatedAt.toISOString(),
  };
}
