/**
 * Where commerce screens link to. In one place because Phase 5 moves "go to the course" from the
 * landing page (where enrolled students' playlists are unlocked) to the course player.
 */

/** The course landing page. */
export function courseHref(slug: string): string {
  return `/course/${encodeURIComponent(slug)}`;
}

/** Where an enrolled student goes to learn (Phase 4: the landing page; Phase 5: the player). */
export function learnHref(slug: string): string {
  return courseHref(slug);
}

export const CART_PATH = '/cart';

/** The page the hosted checkout returns to (and the zero-total path goes to). */
export function checkoutSuccessHref(orderId: string): string {
  return `/checkout/success?orderId=${encodeURIComponent(orderId)}`;
}

export function orderHref(orderId: string): string {
  return `/account/orders/${encodeURIComponent(orderId)}`;
}

export function receiptHref(orderId: string): string {
  return `${orderHref(orderId)}/receipt`;
}

/** The login page, coming back to `next` afterwards. */
export function loginHref(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export const VERIFY_EMAIL_PATH = '/verify-email/pending';
