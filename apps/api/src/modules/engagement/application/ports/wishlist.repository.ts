import type { DB, Executor, Transaction } from '@udemy/db';

/** Keyset of the wishlist page: `added_at` exactly as SQL printed it, then the course id. */
export interface WishlistKeyset {
  readonly addedAt: string;
  readonly courseId: string;
}

export interface WishlistRow {
  readonly courseId: string;
  readonly addedAt: Date;
  /** `added_at` as exact UTC text (microseconds) for the next cursor. */
  readonly addedAtKey: string;
}

/** `engagement.wishlist_items` (D19): private, insert/delete only. */
export abstract class WishlistRepository {
  abstract contains(userId: string, courseId: string, ex?: Executor): Promise<boolean>;

  /** Takes the user's `wish` advisory lock and counts the items (the cap check, schema doc §10). */
  abstract lockCap(trx: Transaction<DB>, userId: string): Promise<number>;

  /** `INSERT … ON CONFLICT DO NOTHING`; true when this call added the item. */
  abstract add(trx: Transaction<DB>, userId: string, courseId: string): Promise<boolean>;

  /** Idempotent; true when an item was removed. */
  abstract remove(userId: string, courseId: string): Promise<boolean>;

  /** Newest first, keyset (added_at DESC, course_id DESC). */
  abstract listPage(
    userId: string,
    after: WishlistKeyset | null,
    limit: number,
  ): Promise<WishlistRow[]>;

  /** The wishlisted courses among `courseIds`. */
  abstract wishlistedAmong(
    userId: string,
    courseIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}
