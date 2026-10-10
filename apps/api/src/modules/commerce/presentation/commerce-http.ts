import type { Request } from 'express';

/**
 * The `:courseId` route param for `@CheckPolicy({ resource: 'course', ... })` (catalog's
 * `CourseOwnership`: the owner of a non-deleted course; 404 otherwise). Pricing and coupon
 * routes are nested under the course (design §8, P2 finding 2); coupon ids are then resolved
 * within that course.
 */
export const courseIdOf = (req: Request): string => String(req.params.courseId);

/**
 * The `:orderId` route param for `@CheckPolicy({ resource: 'order', ... })` (`OrderOwnership`).
 * For P4-T15/T16's `/me/orders/:orderId/...` routes.
 */
export const orderIdOf = (req: Request): string => String(req.params.orderId);

/** Absolute path of a course coupon (the `Location` of a 201), as the BFFs see it. */
export function courseCouponLocation(courseId: string, couponId: string): string {
  return `/api/v1/courses/${courseId}/coupons/${couponId}`;
}

/** Absolute path of a platform coupon (the `Location` of a 201). */
export function platformCouponLocation(couponId: string): string {
  return `/api/v1/admin/coupons/${couponId}`;
}
