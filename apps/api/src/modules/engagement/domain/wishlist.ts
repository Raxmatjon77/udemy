import { WISHLIST_LIMITS } from '@udemy/contracts';

/** Wishlist rules (Phase 5 learning experience design D19): private, insert/delete only. */

export interface WishlistCourseFacts {
  /** Null when the course has no live revision (never published, or deleted). */
  readonly course: { readonly ownerId: string; readonly status: 'PUBLISHED' | 'ARCHIVED' } | null;
  readonly userId: string;
  readonly hasActiveEnrollment: boolean;
}

export type WishlistAddDecision = 'COURSE_NOT_FOUND' | 'NOT_WISHLISTABLE' | 'ELIGIBLE';

/** Only PUBLISHED courses the caller neither owns nor is enrolled in can be added. */
export function decideWishlistAdd(facts: WishlistCourseFacts): WishlistAddDecision {
  if (facts.course === null) return 'COURSE_NOT_FOUND';
  if (
    facts.course.status !== 'PUBLISHED' ||
    facts.course.ownerId === facts.userId ||
    facts.hasActiveEnrollment
  ) {
    return 'NOT_WISHLISTABLE';
  }
  return 'ELIGIBLE';
}

/** Counted under the `wish` advisory lock (schema doc §10) before the insert. */
export function isWishlistFull(itemCount: number): boolean {
  return itemCount >= WISHLIST_LIMITS.maxItems;
}
