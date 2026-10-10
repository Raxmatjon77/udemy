import { z } from 'zod';
import { CurrencySchema, MoneyAmountSchema, SignedMoneyAmountSchema } from '../money/money';
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
 * Cash-basis totals of the instructor's order lines (`order_lines.instructor_id`, the course
 * owner at sale time) in `[from, to)`: a SALE counts when its order was accepted as paid
 * (`paid_at` in range: PAID / PARTIALLY_REFUNDED / REFUNDED, and PAYMENT_REVIEW orders once an
 * admin accepted them), a REFUND when it SUCCEEDED (`succeeded_at` in range).
 * `salesCount` / `refundCount` = lines / refunds counted, `gross` = Σ list, `discounts` = Σ
 * discount, `refunded` = Σ refunded final amounts, `net` = gross − discounts − refunded,
 * `instructorShare` = Σ SQL-generated share of the sales − Σ share of the refunded lines
 * (`INSTRUCTOR_SHARE_BPS`, 70%, rounded per line by Postgres). Amounts may be negative only
 * when refunds in the range belong to sales before it (`net`, `instructorShare`).
 */
export const SalesTotalsSchema = z.object({
  salesCount: z.number().int().min(0),
  refundCount: z.number().int().min(0),
  gross: MoneyAmountSchema,
  discounts: MoneyAmountSchema,
  refunded: MoneyAmountSchema,
  /** Signed (P4-T16): see above. */
  net: SignedMoneyAmountSchema,
  /** Signed (P4-T16): see above. */
  instructorShare: SignedMoneyAmountSchema,
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
  /** Courses with at least one sale or refund in the range, by net DESC (then course id). */
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
