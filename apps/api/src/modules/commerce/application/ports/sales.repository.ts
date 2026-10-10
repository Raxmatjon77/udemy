import type { Executor } from '@udemy/db';
import type { OrderKeyset } from './order.repository';

/** One row of the cash-basis summary (contracts `SalesTotals`); amounts are SQL decimals. */
export interface SalesTotalsRecord {
  readonly salesCount: number;
  readonly refundCount: number;
  readonly gross: string;
  readonly discounts: string;
  readonly refunded: string;
  readonly net: string;
  readonly instructorShare: string;
}

export interface CourseSalesRecord extends SalesTotalsRecord {
  readonly courseId: string;
  /** The newest line snapshot title of the course in the range. */
  readonly courseTitle: string;
}

export interface SalesSummaryRecord {
  readonly totals: SalesTotalsRecord;
  /** By net DESC, then course id. */
  readonly courses: readonly CourseSalesRecord[];
}

export interface RecentSaleRecord {
  readonly orderLineId: string;
  readonly paidAt: Date;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly currency: string;
  readonly listAmount: string;
  readonly finalAmount: string;
  readonly couponCode: string | null;
  readonly instructorShareAmount: string;
  readonly refunded: boolean;
  /** `paid_at` exact SQL text + the line id (`placedAt` carries the paid_at text). */
  readonly keyset: OrderKeyset;
}

/**
 * Instructor sales (design §5, schema doc §8.6): the instructor's order lines
 * (`order_lines.instructor_id`, the owner at sale time) with the SQL-generated shares. No
 * buyer PII is ever selected.
 */
export abstract class SalesRepository {
  /** `[from, to)`: sales by `orders.paid_at`, refunds by `refunds.succeeded_at`. */
  abstract summary(
    instructorId: string,
    range: { readonly from: Date; readonly to: Date },
    ex?: Executor,
  ): Promise<SalesSummaryRecord>;

  /** Newest first `(paid_at DESC, line id DESC)`. */
  abstract recent(
    instructorId: string,
    page: { readonly courseId?: string; readonly after?: OrderKeyset; readonly limit: number },
    ex?: Executor,
  ): Promise<RecentSaleRecord[]>;
}
