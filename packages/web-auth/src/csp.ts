/**
 * Content-Security-Policy for the Next apps (design §9), sent by `createAuthProxy` on every page
 * with a fresh nonce. Next reads the nonce back from the REQUEST's `Content-Security-Policy`
 * header and puts it on its own inline and bootstrap scripts, so pages must render dynamically
 * (the root layouts call `connection()`).
 *
 * Directives and why:
 * - `script-src 'self' 'nonce-…' 'strict-dynamic'`: only scripts carrying this response's nonce,
 *   plus what they load (Next's chunks, the lazily imported hls.js). `'self'` is ignored by
 *   CSP3 browsers when `'strict-dynamic'` is present and only helps CSP2 browsers.
 *   Development adds `'unsafe-eval'`: React's dev build uses `eval` (server error stacks,
 *   Fast Refresh). Never in production.
 * - `style-src 'self' 'unsafe-inline'`: needed, and the risk is low:
 *   - Radix (`react-remove-scroll`, used by Dialog) injects a `<style>` element at runtime
 *     without a nonce;
 *   - server-rendered `style="…"` attributes (Radix, next/image) cannot
 *     carry a nonce at all (`style-src-attr`);
 *   - Next dev injects CSS through `<style>` tags for HMR.
 *   With a nonce in `style-src`, browsers would ignore `'unsafe-inline'`, so it is one or the
 *   other. Scripts stay locked down, all user text is React-escaped or sanitized markdown
 *   without HTML, so style injection has no way in to begin with.
 * - `img-src 'self' data: blob: <media>`: thumbnails and posters are 302s to presigned MinIO URLs.
 * - `media-src 'self' blob: <media>`: hls.js plays from a MediaSource `blob:` URL; native HLS
 *   (Safari without MSE) and progressive files load from the media origin.
 * - `connect-src 'self' <media>`: hls.js segment GETs and the instructor's upload part PUTs go
 *   straight to MinIO; everything else goes through the same-origin BFF (Next dev's HMR
 *   websocket is same-origin too, covered by `'self'`).
 * - `worker-src 'self' blob:`: hls.js runs its transmuxer in a worker built from a `blob:` URL.
 *   Without it the worker would fall back to `script-src`, where `'strict-dynamic'` blocks it.
 * - `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`
 *   (clickjacking; `X-Frame-Options: DENY` stays for old browsers).
 * - `upgrade-insecure-requests` only in production on an https app origin: on plain-http
 *   `next start` (local, e2e), Safari would upgrade even `http://localhost` and the dev MinIO.
 */

export interface CspInput {
  nonce: string;
  /** `MEDIA_PUBLIC_ORIGIN`, e.g. `http://127.0.0.1:9000`; omitted when not configured. */
  mediaOrigin?: string | undefined;
  /** `NODE_ENV === 'development'`: adds `'unsafe-eval'` to `script-src`. */
  dev: boolean;
  /** Adds `upgrade-insecure-requests`. */
  upgradeInsecureRequests: boolean;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/]{16,}={0,2}$/;
const ORIGIN_PATTERN = /^https?:\/\/[^\s/'";,]+$/;

export function buildContentSecurityPolicy(input: CspInput): string {
  if (!NONCE_PATTERN.test(input.nonce)) throw new Error('CSP nonce must be base64 (≥ 16 chars)');
  // The origin is config, but it is interpolated into a header: refuse anything that could
  // smuggle another source expression or directive.
  if (input.mediaOrigin !== undefined && !ORIGIN_PATTERN.test(input.mediaOrigin)) {
    throw new Error('CSP media origin must be scheme://host[:port]');
  }
  const media = input.mediaOrigin ? [input.mediaOrigin] : [];
  const directives: Array<[string, ...string[]]> = [
    ['default-src', "'self'"],
    [
      'script-src',
      "'self'",
      `'nonce-${input.nonce}'`,
      "'strict-dynamic'",
      ...(input.dev ? ["'unsafe-eval'"] : []),
    ],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:', ...media],
    ['media-src', "'self'", 'blob:', ...media],
    ['connect-src', "'self'", ...media],
    ['worker-src', "'self'", 'blob:'],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  if (input.upgradeInsecureRequests) directives.push(['upgrade-insecure-requests']);
  return directives.map((parts) => parts.join(' ')).join('; ');
}

/** 128 random bits, base64: unguessable and unique per response. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
