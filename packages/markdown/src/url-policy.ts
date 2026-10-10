/**
 * Link URL policy shared by BOTH layers (design D14):
 * - `validateMarkdown` (API write path) rejects anything that is not `ok`;
 * - `<MarkdownView>` (render path) drops the `href` of anything that is not `ok`.
 *
 * The decision is made with the WHATWG URL parser (`new URL`), i.e. the same algorithm the browser
 * runs on an `href`. It strips leading/trailing C0 controls and spaces, removes every ASCII tab and
 * newline, and lowercases the scheme, so `\u0001JaVa\tScRiPt:` is seen as `javascript:` here exactly
 * as the browser would see it. Character references (`jav&#x61;script:`) are already decoded by the
 * markdown parser before the URL reaches this function. Only an allowlist is accepted.
 *
 * Pure ECMAScript (the `URL` global exists in Node and in browsers): no DOM, no React.
 */

/** Schemes an author may link to. */
export const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

/** Schemes that can execute script or render attacker-controlled documents (reported as `unsafe_link`). */
export const SCRIPTABLE_SCHEMES = ['javascript:', 'vbscript:', 'data:', 'livescript:'] as const;

export type UrlRejectionReason =
  /** Empty or whitespace-only destination. */
  | 'empty'
  /** No scheme: relative path, protocol-relative `//host`, fragment `#x` or query `?x`. */
  | 'relative'
  /** Looks like it has a scheme but the WHATWG parser rejects it (e.g. `http://`). */
  | 'malformed'
  /** A script-capable scheme (`javascript:`, `vbscript:`, `data:`...). */
  | 'unsafe_scheme'
  /** Any other scheme (`ftp:`, `file:`, `tel:`...). */
  | 'scheme_not_allowed';

export type UrlVerdict =
  | {
      ok: true;
      /** Normalized serialization (what the browser would use); render this, not the raw input. */
      href: string;
      /** true for `http(s):` (opens in a new tab), false for `mailto:` and in-page fragments. */
      external: boolean;
    }
  | { ok: false; reason: UrlRejectionReason; scheme?: string };

export interface ClassifyUrlOptions {
  /**
   * Accept a bare in-page fragment (`#user-content-fn-1`). Only the renderer enables this, for the
   * footnote links that remark-rehype generates; authors cannot write fragment links.
   */
  allowFragment?: boolean;
}

const allowed: ReadonlySet<string> = new Set(ALLOWED_LINK_SCHEMES);
const scriptable: ReadonlySet<string> = new Set(SCRIPTABLE_SCHEMES);

/** Mirrors the WHATWG pre-processing: strip leading/trailing C0 + space, drop tab/LF/CR anywhere. */
function browserView(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) <= 0x20) start++;
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end--;
  let out = '';
  for (let i = start; i < end; i++) {
    const c = raw.charCodeAt(i);
    if (c !== 0x09 && c !== 0x0a && c !== 0x0d) out += raw[i];
  }
  return out;
}

/** RFC 3986 scheme prefix (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"), lowercased, or null. */
function schemeOf(view: string): string | null {
  const colon = view.indexOf(':');
  if (colon < 1) return null;
  for (let i = 0; i < colon; i++) {
    const c = view.charCodeAt(i) | 0x20; // ASCII lowercase for letters
    const isAlpha = c >= 0x61 && c <= 0x7a;
    const isOther = i > 0 && ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e);
    if (!isAlpha && !isOther) return null;
  }
  return view.slice(0, colon + 1).toLowerCase();
}

export function classifyUrl(raw: string, options: ClassifyUrlOptions = {}): UrlVerdict {
  const view = browserView(raw);
  if (view === '') return { ok: false, reason: 'empty' };
  if (options.allowFragment && view.startsWith('#')) {
    // Same-document reference; percent-encode anything odd so it stays a fragment.
    return { ok: true, href: '#' + encodeURI(view.slice(1)), external: false };
  }

  const scheme = schemeOf(view);
  if (scheme === null) return { ok: false, reason: 'relative' };
  if (scriptable.has(scheme)) return { ok: false, reason: 'unsafe_scheme', scheme };
  if (!allowed.has(scheme)) return { ok: false, reason: 'scheme_not_allowed', scheme };

  let url: URL;
  try {
    url = new URL(view);
  } catch {
    return { ok: false, reason: 'malformed', scheme };
  }
  // Defence in depth: the parser's verdict must agree with the prefix check above.
  if (!allowed.has(url.protocol)) {
    return { ok: false, reason: 'scheme_not_allowed', scheme: url.protocol };
  }
  return { ok: true, href: url.href, external: url.protocol !== 'mailto:' };
}
