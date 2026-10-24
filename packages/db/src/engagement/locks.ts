/**
 * Engagement advisory locks (docs/phase-5-schema-design.md §10, races R12 and the caps).
 * Lock order: anno / wish advisory -> aggregate row (question / subject / stats) -> child rows.
 */
import { sql } from 'kysely';
import { advisoryXactLock2, uuidLockKey } from '../internal/advisory';
import { assertIntInRange } from '../internal/assert';
import type { Executor } from '../transaction';

/** First key of the per-course announcement quota mutex: `'anno'` (0x616e6e6f). */
export const ANNOUNCEMENT_QUOTA_LOCK_CLASS = 1634627183;
/** First key of the per-user wishlist cap mutex: `'wish'` (0x77697368). */
export const WISHLIST_CAP_LOCK_CLASS = 2003399528;

/**
 * R12: takes the `anno` mutex of the course, then counts its announcements of the last
 * `windowDays` days in a new statement, deleted ones included (deleting does not refund quota).
 * The caller rejects at `ANNOUNCEMENT_LIMITS.perCourse` and inserts in the same transaction.
 */
export async function lockAnnouncementQuota(
  executor: Executor,
  courseId: string,
  options: { windowDays?: number } = {},
): Promise<{ postedInWindow: number }> {
  const windowDays = options.windowDays ?? 30;
  assertIntInRange('windowDays', windowDays, 1, 366);
  await advisoryXactLock2(
    executor,
    ANNOUNCEMENT_QUOTA_LOCK_CLASS,
    uuidLockKey(courseId),
    'lockAnnouncementQuota',
  );
  const { rows } = await sql<{ postedInWindow: number }>`
    SELECT count(*)::int AS posted_in_window FROM engagement.announcements
     WHERE course_id = ${courseId} AND created_at > now() - make_interval(days => ${windowDays}::int)
  `.execute(executor);
  return { postedInWindow: rows[0]?.postedInWindow ?? 0 };
}

/** The `wish` mutex of the user, then the item count (the caller rejects at `WISHLIST_LIMITS.maxItems`). */
export async function lockWishlistCap(
  executor: Executor,
  userId: string,
): Promise<{ itemCount: number }> {
  await advisoryXactLock2(
    executor,
    WISHLIST_CAP_LOCK_CLASS,
    uuidLockKey(userId),
    'lockWishlistCap',
  );
  const { rows } = await sql<{ itemCount: number }>`
    SELECT count(*)::int AS item_count FROM engagement.wishlist_items WHERE user_id = ${userId}
  `.execute(executor);
  return { itemCount: rows[0]?.itemCount ?? 0 };
}
