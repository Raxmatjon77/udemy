import type { DB, Executor, Transaction } from '@udemy/db';

/** One `commerce.course_prices` row (numeric as its canonical decimal string). */
export interface CoursePriceRecord {
  readonly courseId: string;
  readonly amount: string;
  readonly currency: string;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

/** One `course_price_changes` row; `previousAmount` = lag(amount) over the course's history. */
export interface PriceChangeRecord {
  readonly id: string;
  readonly courseId: string;
  readonly previousAmount: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly changedBy: string;
  readonly changedAt: Date;
}

/** What an upsert changed (`RETURNING old.amount`, PG 18: NULL for the first price). */
export interface PriceChange {
  readonly previousAmount: string | null;
  readonly amount: string;
  readonly currency: string;
  /** = the history row's `changed_at` (the trigger copies `updated_at`). */
  readonly changedAt: Date;
}

/**
 * `commerce.course_prices` and its trigger-written append-only history (D2). There is no
 * delete: 0.00 means free, and "no row" means "not for sale" (D16).
 */
export abstract class PricingRepository {
  abstract findPrice(courseId: string, ex?: Executor): Promise<CoursePriceRecord | null>;

  /** The rows among `courseIds` (missing ids have no price). */
  abstract findPrices(courseIds: readonly string[], ex?: Executor): Promise<CoursePriceRecord[]>;

  /** Newest first, at most `limit`, `previousAmount` computed over the WHOLE history. */
  abstract listHistory(
    courseId: string,
    limit: number,
    ex?: Executor,
  ): Promise<PriceChangeRecord[]>;

  /**
   * `INSERT ... ON CONFLICT (course_id) DO UPDATE ... WHERE (amount, currency) IS DISTINCT FROM`:
   * the trigger appends the history row in the same statement. null = unchanged (no row
   * written, so the `course_prices_noop_update_ck` guard never fires).
   */
  abstract upsertPrice(
    trx: Transaction<DB>,
    price: { courseId: string; amount: string; currency: string; updatedBy: string },
  ): Promise<PriceChange | null>;

  /**
   * Locks the price row FOR UPDATE (coupon creation, schema doc R8: it serialises the "<= 10
   * active coupons" count and the AMOUNT <= list price rule against price changes).
   */
  abstract lockPrice(trx: Transaction<DB>, courseId: string): Promise<CoursePriceRecord | null>;
}
