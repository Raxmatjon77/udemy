import { Injectable } from '@nestjs/common';
import { type Executor, sql } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { OrderKeyset } from '../application/ports/order.repository';
import {
  type CourseSalesRecord,
  type RecentSaleRecord,
  SalesRepository,
  type SalesSummaryRecord,
  type SalesTotalsRecord,
} from '../application/ports/sales.repository';

/** A SQL decimal (`-12.34`) as exact integer cents, for ordering only. */
const centsOf = (amount: string): bigint => BigInt(amount.replace('.', ''));

const ZERO: SalesTotalsRecord = {
  salesCount: 0,
  refundCount: 0,
  gross: '0.00',
  discounts: '0.00',
  refunded: '0.00',
  net: '0.00',
  instructorShare: '0.00',
};

/**
 * Schema doc §8.6 (as `@udemy/db` `getInstructorSalesSummary` / `listRecentSales`), plus the
 * refund count, the course title and the currency the contracts need. Sums are cast to
 * `numeric(14,2)` so they print with two decimals (`0.00`, never `0`).
 */
@Injectable()
export class KyselySalesRepository extends SalesRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async summary(
    instructorId: string,
    range: { from: Date; to: Date },
    ex: Executor = this.db,
  ): Promise<SalesSummaryRecord> {
    const { rows } = await sql<
      SalesTotalsRecord & { courseId: string | null; courseTitle: string }
    >`
      WITH mine AS (
        SELECT l.id, l.course_id, l.course_title, l.list_amount, l.discount_amount, l.final_amount,
               l.instructor_share_amount, o.paid_at
          FROM commerce.order_lines l
          JOIN commerce.orders o ON o.id = l.order_id
         WHERE l.instructor_id = ${instructorId} AND o.paid_at IS NOT NULL),
      facts AS (
        SELECT 'S' AS k, m.course_id, m.course_title, m.paid_at AS at, m.list_amount,
               m.discount_amount, m.final_amount, m.instructor_share_amount
          FROM mine m WHERE m.paid_at >= ${range.from} AND m.paid_at < ${range.to}
        UNION ALL
        SELECT 'R', m.course_id, m.course_title, r.succeeded_at, 0, 0, r.amount, m.instructor_share_amount
          FROM mine m JOIN commerce.refunds r ON r.order_line_id = m.id AND r.status = 'SUCCEEDED'
         WHERE r.succeeded_at >= ${range.from} AND r.succeeded_at < ${range.to})
      SELECT course_id,
             (array_agg(course_title ORDER BY at DESC))[1]                                  AS course_title,
             (count(*) FILTER (WHERE k = 'S'))::int                                        AS sales_count,
             (count(*) FILTER (WHERE k = 'R'))::int                                        AS refund_count,
             coalesce(sum(list_amount) FILTER (WHERE k = 'S'), 0)::numeric(14,2)::text      AS gross,
             coalesce(sum(discount_amount) FILTER (WHERE k = 'S'), 0)::numeric(14,2)::text  AS discounts,
             coalesce(sum(final_amount) FILTER (WHERE k = 'R'), 0)::numeric(14,2)::text     AS refunded,
             (coalesce(sum(final_amount) FILTER (WHERE k = 'S'), 0)
               - coalesce(sum(final_amount) FILTER (WHERE k = 'R'), 0))::numeric(14,2)::text AS net,
             (coalesce(sum(instructor_share_amount) FILTER (WHERE k = 'S'), 0)
               - coalesce(sum(instructor_share_amount) FILTER (WHERE k = 'R'), 0))::numeric(14,2)::text
                                                                                            AS instructor_share
        FROM facts
       GROUP BY ROLLUP (course_id)
    `.execute(ex);
    const total = rows.find((r) => r.courseId === null);
    const courses: CourseSalesRecord[] = rows
      .flatMap((r) => (r.courseId === null ? [] : [{ ...r, courseId: r.courseId }]))
      .sort(
        (a, b) =>
          Number(centsOf(b.net) - centsOf(a.net)) ||
          (a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0),
      );
    if (total === undefined) return { totals: { ...ZERO }, courses };
    const { salesCount, refundCount, gross, discounts, refunded, net, instructorShare } = total;
    return {
      totals: { salesCount, refundCount, gross, discounts, refunded, net, instructorShare },
      courses,
    };
  }

  async recent(
    instructorId: string,
    page: { courseId?: string; after?: OrderKeyset; limit: number },
    ex: Executor = this.db,
  ): Promise<RecentSaleRecord[]> {
    const course = page.courseId === undefined ? sql`` : sql`AND l.course_id = ${page.courseId}`;
    const after =
      page.after === undefined
        ? sql``
        : sql`AND (o.paid_at, l.id) < (${page.after.placedAt}::timestamptz, ${page.after.id}::uuid)`;
    const { rows } = await sql<Omit<RecentSaleRecord, 'keyset'> & { paidAtText: string }>`
      SELECT l.id AS order_line_id, o.paid_at,
             to_char(o.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paid_at_text,
             l.course_id, l.course_title, o.currency, l.list_amount, l.final_amount,
             c.code AS coupon_code, l.instructor_share_amount,
             EXISTS (SELECT 1 FROM commerce.refunds r
                      WHERE r.order_line_id = l.id AND r.status = 'SUCCEEDED') AS refunded
        FROM commerce.order_lines l
        JOIN commerce.orders o ON o.id = l.order_id
        LEFT JOIN commerce.coupons c ON c.id = l.coupon_id
       WHERE l.instructor_id = ${instructorId} AND o.paid_at IS NOT NULL ${course} ${after}
       ORDER BY o.paid_at DESC, l.id DESC
       LIMIT ${page.limit}
    `.execute(ex);
    return rows.map(({ paidAtText, ...row }) => ({
      ...row,
      keyset: { placedAt: paidAtText, id: row.orderLineId },
    }));
  }
}
