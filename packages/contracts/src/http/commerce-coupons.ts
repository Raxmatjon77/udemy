import { z } from 'zod';
import { CurrencySchema, MoneyAmountSchema, moneyToMinor } from '../money/money';
import {
  CouponCodeSchema,
  CouponDiscountTypeSchema,
  CouponScopeSchema,
  CouponStateSchema,
} from './commerce-common';
import { IsoDateTimeSchema, UuidSchema } from './fields';
import { pageSchema, PaginationQuerySchema } from './pagination';

/* ----------------------------------------------------------------------------------------
 * Course coupons (instructor BFF, `@CheckPolicy` course:read / course:update):
 *
 *   GET  /courses/:courseId/coupons                       -> 200 CouponPage        (404)
 *   POST /courses/:courseId/coupons                       -> 201 Coupon            (404, 409
 *        coupon_code_taken, 422 coupon_limit_exceeded | course_is_free | validation_failed)
 *   POST /courses/:courseId/coupons/:couponId/deactivate  -> 200 Coupon            (404; idempotent)
 *
 * Platform coupons (admin BFF, P `platform_coupon:manage`):
 *
 *   GET  /admin/coupons                                   -> 200 CouponPage
 *   POST /admin/coupons                                   -> 201 Coupon (409 coupon_code_taken, 422)
 *   POST /admin/coupons/:couponId/deactivate              -> 200 Coupon            (404; idempotent)
 *
 * Coupons are immutable after creation except deactivation (D5). Pages are newest first.
 * The checks relative to "now" (`startsAt` ≤ 90 days ahead, `endsAt` in the future) and the
 * AMOUNT ≤ list price rule are the api's; the schemas check what needs no clock or DB.
 * -------------------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

export const COUPON_LIMITS = Object.freeze({
  /** Active (not deactivated, not expired) coupons per course. */
  maxActivePerCourse: 10,
  /** Course coupon validity window, in days. */
  courseWindowMinDays: 1,
  courseWindowMaxDays: 31,
  /** Platform coupon validity window, in days (no minimum beyond `endsAt > startsAt`). */
  platformWindowMaxDays: 90,
  /** `startsAt` may be at most this many days in the future. */
  maxStartAheadDays: 90,
  maxRedemptions: 100_000,
  minPercentOff: 1,
  maxPercentOff: 100,
  /** Coupon creations per user per 24 h (§9). */
  creationsPerDay: 50,
});

export const CourseCouponParamsSchema = z.object({ courseId: UuidSchema, couponId: UuidSchema });
export type CourseCouponParams = z.output<typeof CourseCouponParamsSchema>;

export const CouponIdParamsSchema = z.object({ couponId: UuidSchema });
export type CouponIdParams = z.output<typeof CouponIdParamsSchema>;

const PercentOffSchema = z
  .number()
  .int()
  .min(COUPON_LIMITS.minPercentOff)
  .max(COUPON_LIMITS.maxPercentOff);

const MaxRedemptionsSchema = z.number().int().min(1).max(COUPON_LIMITS.maxRedemptions);

/** Shared coupon window fields; `startsAt` defaults to "now" on the server. */
const couponWindowFields = {
  code: CouponCodeSchema,
  startsAt: IsoDateTimeSchema.optional(),
  endsAt: IsoDateTimeSchema,
  maxRedemptions: MaxRedemptionsSchema.optional(),
};

/** `endsAt - startsAt` in days, when `startsAt` is given; null otherwise. */
function windowDays(window: { startsAt?: string; endsAt: string }): number | null {
  if (window.startsAt === undefined) return null;
  return (Date.parse(window.endsAt) - Date.parse(window.startsAt)) / DAY_MS;
}

function checkWindow(
  window: { startsAt?: string; endsAt: string },
  minDays: number,
  maxDays: number,
  ctx: z.RefinementCtx,
): void {
  const days = windowDays(window);
  if (days === null) return;
  if (days <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Must be after startsAt', path: ['endsAt'] });
  } else if (days < minDays || days > maxDays) {
    ctx.addIssue({
      code: 'custom',
      message: `The coupon must run for ${minDays}–${maxDays} days`,
      path: ['endsAt'],
    });
  }
}

export const CreateCourseCouponRequestSchema = z
  .discriminatedUnion('discountType', [
    z.object({
      ...couponWindowFields,
      discountType: z.literal('PERCENT'),
      percentOff: PercentOffSchema,
    }),
    z.object({
      ...couponWindowFields,
      discountType: z.literal('AMOUNT'),
      /** Off the list price, in the platform currency; > 0 and ≤ the current list price. */
      amountOff: MoneyAmountSchema.refine((amount) => moneyToMinor(amount) > 0, {
        message: 'Must be greater than 0.00',
      }),
    }),
  ])
  .superRefine((coupon, ctx) =>
    checkWindow(coupon, COUPON_LIMITS.courseWindowMinDays, COUPON_LIMITS.courseWindowMaxDays, ctx),
  );
export type CreateCourseCouponRequest = z.output<typeof CreateCourseCouponRequestSchema>;

/** Platform coupons are PERCENT only (the `coupons` CHECK). */
export const CreatePlatformCouponRequestSchema = z
  .object({
    ...couponWindowFields,
    discountType: z.literal('PERCENT').default('PERCENT'),
    percentOff: PercentOffSchema,
  })
  .superRefine((coupon, ctx) => checkWindow(coupon, 0, COUPON_LIMITS.platformWindowMaxDays, ctx));
export type CreatePlatformCouponRequest = z.output<typeof CreatePlatformCouponRequestSchema>;

/** A coupon with its terms, derived state and redemption counts (§5 `ListCoupons`). */
export const CouponSchema = z.object({
  id: UuidSchema,
  scope: CouponScopeSchema,
  /** Null for PLATFORM coupons. */
  courseId: UuidSchema.nullable(),
  code: z.string(),
  discountType: CouponDiscountTypeSchema,
  /** PERCENT only. */
  percentOff: z.number().int().min(1).max(100).nullable(),
  /** AMOUNT only, with `currency`. */
  amountOff: MoneyAmountSchema.nullable(),
  currency: CurrencySchema.nullable(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  maxRedemptions: z.number().int().min(1).nullable(),
  state: CouponStateSchema,
  redemptions: z.object({
    reserved: z.number().int().min(0),
    consumed: z.number().int().min(0),
  }),
  createdBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  deactivatedAt: IsoDateTimeSchema.nullable(),
});
export type Coupon = z.infer<typeof CouponSchema>;

export const CouponsQuerySchema = PaginationQuerySchema;
export type CouponsQuery = z.output<typeof CouponsQuerySchema>;

export const CouponPageSchema = pageSchema(CouponSchema);
export type CouponPage = z.infer<typeof CouponPageSchema>;
