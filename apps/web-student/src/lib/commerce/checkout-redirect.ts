import { assignLocation } from './navigation';

/**
 * The checkout hand-off to the hosted payment page (Phase 4 D1, §10).
 *
 * The API returns a Stripe Checkout URL (a bearer capability: never log it). Before the browser
 * navigates there, its origin must be one of `CHECKOUT_ALLOWED_ORIGINS` (server env, passed to
 * the page as a prop), so a tampered or buggy response cannot send the buyer to a look-alike
 * page. The navigation is a top-level `location.assign`, which the CSP does not restrict
 * (`form-action` only covers form submissions; there is no `navigate-to`).
 */

/** True when `url` is an absolute http(s) URL whose origin is exactly one of `allowedOrigins`. */
export function isAllowedCheckoutUrl(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // Credentials in the URL would let a look-alike pass a naive prefix check; never accept them.
  if (parsed.username !== '' || parsed.password !== '') return false;
  return allowedOrigins.includes(parsed.origin);
}

/**
 * Navigates to the payment page when the origin is allowed. Returns false (and stays) otherwise,
 * for the caller to show an error.
 */
export function redirectToCheckout(url: string, allowedOrigins: readonly string[]): boolean {
  if (!isAllowedCheckoutUrl(url, allowedOrigins)) return false;
  assignLocation(url);
  return true;
}
