import { z } from 'zod';
import { CurrencySchema, MoneyAmountSchema } from '../money/money';
import { CourseTitleSnapshotSchema } from './commerce-common';
import { IsoDateTimeSchema, UuidSchema } from './fields';
import { emptyToUndefined, pageSchema, PaginationQuerySchema } from './pagination';

/* ----------------------------------------------------------------------------------------
 * Instructor sales (instructor BFF, P `sales:read:own`). The principal is the instructor;
 * there is **no buyer PII** in any of these responses (§5).
 *
 *   GET /instructor/sales/summary?from=&to= -> 200 SalesSummary (400; range ≤ 366 days)
 *   GET /instructor/sales?courseId=&cursor=&limit= -> 200 RecentSalePage (paidAt DESC, id DESC)
 * -------------------------------------------------------------------------------------- */

export const SALES_SUMMARY_MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `[from, to)` over `paid_at`. */
export const SalesSummaryQuerySchema = z
  .object({ from: IsoDateTimeSchema, to: IsoDateTimeSchema })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), {
    message: 'from must be before to',
    path: ['to'],
  })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= SALES_SUMMARY_MAX_RANGE_DAYS * DAY_MS, {
    message: `The range must be at most ${SALES_SUMMARY_MAX_RANGE_DAYS} days`,
    path: ['to'],
  });
export type SalesSummaryQuery = z.output<typeof SalesSummaryQuerySchema>;

/**
 * Totals over lines of PAID / PARTIALLY_REFUNDED / REFUNDED orders and their SUCCEEDED refunds.
 * `gross` = Σ list, `discounts` = Σ discount, `refunded` = Σ refunded final amounts,
 * `net` = gross − discounts − refunded, `instructorShare` = Σ share of the non-refunded lines.
 */
export const SalesTotalsSchema = z.object({
  salesCount: z.number().int().min(0),
  refundCount: z.number().int().min(0),
  gross: MoneyAmountSchema,
  discounts: MoneyAmountSchema,
  refunded: MoneyAmountSchema,
  net: MoneyAmountSchema,
  instructorShare: MoneyAmountSchema,
});
export type SalesTotals = z.infer<typeof SalesTotalsSchema>;

export const CourseSalesSchema = SalesTotalsSchema.extend({
  courseId: UuidSchema,
  /** The latest snapshot title. */
  courseTitle: CourseTitleSnapshotSchema,
});
export type CourseSales = z.infer<typeof CourseSalesSchema>;

export const SalesSummarySchema = z.object({
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  currency: CurrencySchema,
  totals: SalesTotalsSchema,
  /** Courses with at least one sale in the range, by net DESC. */
  courses: z.array(CourseSalesSchema),
});
export type SalesSummary = z.infer<typeof SalesSummarySchema>;

export const RecentSalesQuerySchema = PaginationQuerySchema.extend({
  courseId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
});
export type RecentSalesQuery = z.output<typeof RecentSalesQuerySchema>;

export const RecentSaleSchema = z.object({
  orderLineId: UuidSchema,
  paidAt: IsoDateTimeSchema,
  courseId: UuidSchema,
  courseTitle: CourseTitleSnapshotSchema,
  currency: CurrencySchema,
  listAmount: MoneyAmountSchema,
  finalAmount: MoneyAmountSchema,
  couponCode: z.string().nullable(),
  instructorShareAmount: MoneyAmountSchema,
  /** A SUCCEEDED refund exists for the line. */
  refunded: z.boolean(),
});
export type RecentSale = z.infer<typeof RecentSaleSchema>;

export const RecentSalePageSchema = pageSchema(RecentSaleSchema);
export type RecentSalePage = z.infer<typeof RecentSalePageSchema>;
