import {
  CouponPageSchema,
  CouponSchema,
  CoursePricingSchema,
  RecentSalePageSchema,
  SalesSummarySchema,
  type Coupon,
  type CouponPage,
  type CoursePricing,
  type CreateCourseCouponRequest,
  type RecentSalePage,
  type SalesSummary,
  type SalesSummaryQuery,
} from '@udemy/contracts';

import { api, queryString } from './api';

/*
 * Typed calls for instructor commerce (Phase 4 design §8, "Instructor (instructor BFF)"):
 * pricing, course coupons and sales. Every response is validated against its contracts schema.
 * Paths are relative to `/api/proxy`.
 */

const enc = encodeURIComponent;
const course = (courseId: string) => `/courses/${enc(courseId)}`;

/** Page size of the coupon table and the recent-sales list. */
export const COMMERCE_PAGE_LIMIT = 20;

export const commerceApi = {
  /* ---- pricing (D2) ---- */
  pricing: (courseId: string): Promise<CoursePricing> =>
    api(`${course(courseId)}/pricing`, { schema: CoursePricingSchema }),
  /** `"0.00"` makes the course free. 422 `price_not_allowed`, 429 (10 changes per day). */
  setPrice: (courseId: string, amount: string): Promise<CoursePricing> =>
    api(`${course(courseId)}/pricing`, {
      method: 'PUT',
      json: { amount },
      schema: CoursePricingSchema,
    }),

  /* ---- course coupons (D5) ---- */
  coupons: (courseId: string, cursor: string | null): Promise<CouponPage> =>
    api(`${course(courseId)}/coupons${queryString({ cursor, limit: COMMERCE_PAGE_LIMIT })}`, {
      schema: CouponPageSchema,
    }),
  createCoupon: (courseId: string, body: CreateCourseCouponRequest): Promise<Coupon> =>
    api(`${course(courseId)}/coupons`, { method: 'POST', json: body, schema: CouponSchema }),
  /** Idempotent. */
  deactivateCoupon: (courseId: string, couponId: string): Promise<Coupon> =>
    api(`${course(courseId)}/coupons/${enc(couponId)}/deactivate`, {
      method: 'POST',
      json: {},
      schema: CouponSchema,
    }),

  /* ---- sales (no buyer PII) ---- */
  salesSummary: ({ from, to }: SalesSummaryQuery): Promise<SalesSummary> =>
    api(`/instructor/sales/summary${queryString({ from, to })}`, { schema: SalesSummarySchema }),
  recentSales: (params: { cursor: string | null; courseId?: string }): Promise<RecentSalePage> =>
    api(
      `/instructor/sales${queryString({
        courseId: params.courseId,
        cursor: params.cursor,
        limit: COMMERCE_PAGE_LIMIT,
      })}`,
      { schema: RecentSalePageSchema },
    ),
};
