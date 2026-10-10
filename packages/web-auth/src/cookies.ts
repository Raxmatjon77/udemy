import 'server-only';
import type { WebAuthConfig } from './config';

/**
 * Auth cookies (design §9). Set only by this BFF; the API never sets cookies.
 *
 * | cookie                   | attributes                                                       |
 * | ------------------------ | ---------------------------------------------------------------- |
 * | `__Host-udemy-{app}-rt`  | HttpOnly; Secure; Path=/; SameSite; Max-Age = rtExpiresAt − now  |
 * | `__Host-udemy-{app}-at`  | HttpOnly; Secure; Path=/; SameSite; Max-Age = 870                |
 *
 * With `cookieSecure=false` (dev only, refused in production by the config) the `__Host-`
 * prefix and `Secure` are dropped, because browsers reject `__Host-` without `Secure`.
 *
 * The helpers write raw `Set-Cookie` headers so they work on any `Response` (route handlers,
 * streamed proxy responses and `NextResponse` from proxy.ts alike).
 */

/** Access cookie lifetime: 15 min token minus a 30 s margin, so the cookie dies before the JWT. */
export const ACCESS_COOKIE_MAX_AGE_S = 870;

export interface CookieNames {
  readonly refresh: string;
  readonly access: string;
}

export function cookieNames(config: WebAuthConfig): CookieNames {
  const prefix = config.cookieSecure ? '__Host-' : '';
  return {
    refresh: `${prefix}${config.cookiePrefix}-rt`,
    access: `${prefix}${config.cookiePrefix}-at`,
  };
}

export interface CookieAttributes {
  maxAge: number;
  secure: boolean;
  sameSite: 'lax' | 'strict';
}

// RFC 6265 cookie-octet: our values are JWTs and base64url tokens, so this never rejects real data.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

export function serializeCookie(name: string, value: string, attrs: CookieAttributes): string {
  if (!COOKIE_VALUE.test(value)) throw new Error(`Refusing to set cookie ${name}: invalid value`);
  const parts = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(attrs.maxAge))}`,
    'HttpOnly',
    `SameSite=${attrs.sameSite === 'strict' ? 'Strict' : 'Lax'}`,
  ];
  if (attrs.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Tokens to store after login or refresh. `refreshToken` is absent on the refresh grace path. */
export interface SessionCookieTokens {
  accessToken: string;
  refreshToken?: string | undefined;
  refreshTokenExpiresAt?: string | undefined;
}

/** Seconds until an ISO timestamp, floored, never negative. */
export function secondsUntil(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
}

/**
 * The `Set-Cookie` values for a login/refresh result. When there is no new refresh token
 * (the API's reuse-grace path) the rt cookie is not touched, so the browser keeps the one it
 * has, which may already be the rotated token from a parallel request.
 */
export function sessionSetCookies(
  config: WebAuthConfig,
  tokens: SessionCookieTokens,
  now: number = Date.now(),
): string[] {
  const names = cookieNames(config);
  const base = { secure: config.cookieSecure, sameSite: config.sameSite };
  const out = [
    serializeCookie(names.access, tokens.accessToken, { ...base, maxAge: ACCESS_COOKIE_MAX_AGE_S }),
  ];
  if (tokens.refreshToken && tokens.refreshTokenExpiresAt) {
    out.push(
      serializeCookie(names.refresh, tokens.refreshToken, {
        ...base,
        maxAge: secondsUntil(tokens.refreshTokenExpiresAt, now),
      }),
    );
  }
  return out;
}

/** `Set-Cookie` values that delete both cookies (Max-Age=0, same name/path/flags). */
export function clearSetCookies(config: WebAuthConfig): string[] {
  const names = cookieNames(config);
  const attrs = { secure: config.cookieSecure, sameSite: config.sameSite, maxAge: 0 };
  return [serializeCookie(names.access, '', attrs), serializeCookie(names.refresh, '', attrs)];
}

export function setSessionCookies(
  headers: Headers,
  config: WebAuthConfig,
  tokens: SessionCookieTokens,
  now?: number,
): void {
  for (const cookie of sessionSetCookies(config, tokens, now)) headers.append('set-cookie', cookie);
}

export function clearSessionCookies(headers: Headers, config: WebAuthConfig): void {
  for (const cookie of clearSetCookies(config)) headers.append('set-cookie', cookie);
}

/** Reads a cookie from a raw `Cookie` request header. */
export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

export function readAuthCookies(
  request: Request,
  config: WebAuthConfig,
): { accessToken?: string | undefined; refreshToken?: string | undefined } {
  const names = cookieNames(config);
  const header = request.headers.get('cookie');
  return {
    accessToken: readCookie(header, names.access),
    refreshToken: readCookie(header, names.refresh),
  };
}

/**
 * Rewrites a raw `Cookie` request header: removes `remove` names and sets `set` entries,
 * leaving every other cookie byte-for-byte untouched. Used by proxy.ts so the RSC render of
 * this same request sees the freshly refreshed access token.
 */
export function rewriteCookieHeader(
  cookieHeader: string | null,
  changes: { set?: Record<string, string>; remove?: readonly string[] },
): string {
  const set = changes.set ?? {};
  const drop = new Set([...(changes.remove ?? []), ...Object.keys(set)]);
  const kept = (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => {
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      return !drop.has(name);
    });
  for (const [name, value] of Object.entries(set)) kept.push(`${name}=${value}`);
  return kept.join('; ');
}
