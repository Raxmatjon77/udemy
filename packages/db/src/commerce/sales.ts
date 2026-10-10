/**
 * Instructor sales (docs/phase-4-schema-design.md §8.6): sales by `orders.paid_at`, refunds by
 * `refunds.succeeded_at`, no buyer PII. Amounts are numeric strings.
 */
import { sql } from 'kysely';
import { assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';

/** GetSalesSummary accepts ranges up to 366 days. */
export const MAX_SALES_RANGE_DAYS = 366;
const MAX_PAGE_SIZE = 200;

export interface SalesSummaryRow {
  salesCount: string;
  gross: string;
  discounts: string;
  refunded: string;
  net: string;
  instructorShare: string;
}

export interface SalesSummary {
  total: SalesSummaryRow;
  byCourse: (SalesSummaryRow & { courseId: string })[];
}

const ZERO_ROW: SalesSummaryRow = {
  salesCount: '0',
  gross: '0',
  discounts: '0',
  refunded: '0',
  net: '0',
  instructorShare: '0',
};

/** `[from, to)`; throws RangeError for an empty/inverted range or one longer than 366 days. */
export async function getInstructorSalesSummary(
  executor: Executor,
  input: { instructorId: string; from: Date; to: Date },
): Promise<SalesSummary> {
  const ms = input.to.getTime() - input.from.getTime();
  if (!(ms > 0) || ms > MAX_SALES_RANGE_DAYS * 86_400_000) {
    throw new RangeError(`sales range must be 0 < to - from <= ${MAX_SALES_RANGE_DAYS} days`);
  }
  const { rows } = await sql<SalesSummaryRow & { courseId: string | null }>`
    WITH mine AS (
      SELECT l.id, l.course_id, l.list_amount, l.discount_amount, l.final_amount, l.instructor_share_amount, o.paid_at
        FROM commerce.order_lines l
        JOIN commerce.orders o ON o.id = l.order_id
       WHERE l.instructor_id = ${input.instructorId} AND o.paid_at IS NOT NULL),
    facts AS (
      SELECT 'S' AS k, m.course_id, m.list_amount, m.discount_amount, m.final_amount, m.instructor_share_amount
        FROM mine m WHERE m.paid_at >= ${input.from} AND m.paid_at < ${input.to}
      UNION ALL
      SELECT 'R', m.course_id, 0, 0, r.amount, m.instructor_share_amount
        FROM mine m JOIN commerce.refunds r ON r.order_line_id = m.id AND r.status = 'SUCCEEDED'
       WHERE r.succeeded_at >= ${input.from} AND r.succeeded_at < ${input.to})
    SELECT course_id,
           count(*) FILTER (WHERE k = 'S')                                         AS sales_count,
           coalesce(sum(list_amount)     FILTER (WHERE k = 'S'), 0)                AS gross,
           coalesce(sum(discount_amount) FILTER (WHERE k = 'S'), 0)                AS discounts,
           coalesce(sum(final_amount)    FILTER (WHERE k = 'R'), 0)                AS refunded,
           coalesce(sum(final_amount)    FILTER (WHERE k = 'S'), 0)
             - coalesce(sum(final_amount) FILTER (WHERE k = 'R'), 0)               AS net,
           coalesce(sum(instructor_share_amount) FILTER (WHERE k = 'S'), 0)
             - coalesce(sum(instructor_share_amount) FILTER (WHERE k = 'R'), 0)    AS instructor_share
      FROM facts
     GROUP BY ROLLUP (course_id)
     ORDER BY course_id NULLS FIRST
  `.execute(executor);
  const total = rows.find((r) => r.courseId === null);
  const byCourse = rows.filter((r) => r.courseId !== null) as SalesSummary['byCourse'];
  if (total === undefined) return { total: { ...ZERO_ROW }, byCourse };
  const { salesCount, gross, discounts, refunded, net, instructorShare } = total;
  return { total: { salesCount, gross, discounts, refunded, net, instructorShare }, byCourse };
}

/** Keyset position: exact `paid_at` text (microseconds) + the line id. */
export interface RecentSaleCursor {
  paidAt: string;
  lineId: string;
}

export interface RecentSale {
  lineId: string;
  paidAt: Date;
  courseTitle: string;
  finalAmount: string;
  instructorShareAmount: string;
  couponCode: string | null;
  refunded: boolean;
  cursor: RecentSaleCursor;
}

/** ListRecentSales: newest first, keyset on (paid_at, line id) DESC. */
export async function listRecentSales(
  executor: Executor,
  input: { instructorId: string; limit: number; after?: RecentSaleCursor },
): Promise<RecentSale[]> {
  assertIntInRange('limit', input.limit, 1, MAX_PAGE_SIZE);
  const after =
    input.after === undefined
      ? sql``
      : sql`AND (o.paid_at, l.id) < (${input.after.paidAt}::timestamptz, ${input.after.lineId}::uuid)`;
  const { rows } = await sql<Omit<RecentSale, 'cursor'> & { cursorAt: string }>`
    SELECT l.id AS line_id, o.paid_at, o.paid_at::text AS cursor_at, l.course_title, l.final_amount,
           l.instructor_share_amount, c.code AS coupon_code,
           EXISTS (SELECT 1 FROM commerce.refunds r WHERE r.order_line_id = l.id AND r.status = 'SUCCEEDED') AS refunded
      FROM commerce.order_lines l
      JOIN commerce.orders o ON o.id = l.order_id
      LEFT JOIN commerce.coupons c ON c.id = l.coupon_id
     WHERE l.instructor_id = ${input.instructorId} AND o.paid_at IS NOT NULL
       ${after}
     ORDER BY o.paid_at DESC, l.id DESC
     LIMIT ${input.limit}
  `.execute(executor);
  return rows.map(({ cursorAt, ...row }) => ({
    ...row,
    cursor: { paidAt: cursorAt, lineId: row.lineId },
  }));
}
