import type { CouponState } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { CouponTermsRow } from '../../domain/coupon-terms';
import type { QuoteRow } from '../../domain/quote';

/** A coupon whose code equals the cart's code (for a cart course or the platform). */
export interface CouponCandidateRecord extends CouponTermsRow {
  /** Derived at the statement's `now()`. */
  readonly state: CouponState;
  readonly usedByMe: boolean;
}

/** `quoteCart` (schema doc §8.1): the DB-priced lines plus the coupon candidates. */
export interface CartQuoteRecord {
  readonly lines: readonly QuoteRow[];
  readonly candidates: readonly CouponCandidateRecord[];
}

/**
 * The server cart (D4: signed-in users only): `commerce.carts` (also the per-user commerce
 * mutex, lock order step 1) and `commerce.cart_items`. The item count limit is enforced by the
 * app under the cart row lock.
 */
export abstract class CartRepository {
  /** Creates the cart row if needed and locks it FOR UPDATE (`lockUserCart`). */
  abstract lockCart(trx: Transaction<DB>, userId: string): Promise<{ couponCode: string | null }>;

  /** The stored (uppercased) code; null without a cart or a code. */
  abstract findCouponCode(userId: string, ex?: Executor): Promise<string | null>;

  /**
   * The quote inputs. Run it inside a transaction so both statements see the same `now()`
   * (and, in checkout, after the cart and coupon locks).
   */
  abstract quote(userId: string, ex: Executor): Promise<CartQuoteRecord>;

  /** Cart course ids, oldest first. */
  abstract listCourseIds(userId: string, ex?: Executor): Promise<string[]>;

  /** `ON CONFLICT DO NOTHING`; true when the row was inserted. Requires the cart row (lock first). */
  abstract addItem(trx: Transaction<DB>, userId: string, courseId: string): Promise<boolean>;

  /** Idempotent. */
  abstract removeItem(userId: string, courseId: string, ex?: Executor): Promise<void>;

  /** Requires the cart row (lock first). */
  abstract setCouponCode(trx: Transaction<DB>, userId: string, code: string | null): Promise<void>;

  /** The ids among `courseIds` that are in the user's cart. */
  abstract findInCart(
    userId: string,
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlySet<string>>;
}
