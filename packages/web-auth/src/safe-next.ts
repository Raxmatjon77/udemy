/**
 * Validation of the `next` redirect parameter (design §9: no open redirects).
 *
 * Isomorphic (no `server-only`): the login page uses it in the browser before
 * `router.replace(next)`, and proxy.ts uses it when it builds `/login?next=`.
 *
 * Accepted: a relative path starting with exactly one `/`, e.g. `/account?tab=1#x`.
 * Rejected:
 * - anything not starting with `/`, including absolute URLs and `javascript:` (a scheme);
 * - protocol-relative `//host` and `/\host` (browsers treat `\` as `/`), and any `\` at all;
 * - control characters and whitespace-like trickery (browsers strip tab/CR/LF, so
 *   `/\t/evil.com` would become `//evil.com`);
 * - the same tricks after one round of percent-decoding (`/%2F%2Fevil.com`, `/%5Cevil`), in
 *   case a consumer decodes before navigating;
 * - values over 2048 characters.
 */

const MAX_LENGTH = 2048;
// C0, DEL, C1 controls, plus Unicode line/paragraph separators and BOM / zero-width chars.
const FORBIDDEN_CHARS = /[\p{Cc}\u2028\u2029\uFEFF\u200B-\u200D]/u;
const PROBE_ORIGIN = 'http://safe-next.invalid';

function hasSafeShape(value: string): boolean {
  if (!value.startsWith('/')) return false;
  const second = value.charAt(1);
  if (second === '/' || second === '\\') return false;
  if (value.includes('\\')) return false;
  if (FORBIDDEN_CHARS.test(value)) return false;
  return true;
}

export function isSafeNextPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return false;
  if (!hasSafeShape(value)) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false; // malformed percent-encoding
  }
  if (!hasSafeShape(decoded)) return false;

  // Final check with the WHATWG URL parser: resolving against a fixed origin must stay on it.
  try {
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

/** Returns `value` when it is a safe relative path, otherwise `fallback`. */
export function safeNextPath(value: unknown, fallback: string): string;
export function safeNextPath(value: unknown, fallback?: undefined): string | null;
export function safeNextPath(value: unknown, fallback?: string): string | null {
  return isSafeNextPath(value) ? value : (fallback ?? null);
}
