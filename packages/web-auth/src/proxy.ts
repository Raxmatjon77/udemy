import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { lazyWithConfig, type WebAuthConfig, type WebAuthConfigSource } from './config';
import {
  clearSetCookies,
  cookieNames,
  readAuthCookies,
  type CookieNames,
  rewriteCookieHeader,
  sessionSetCookies,
} from './cookies';
import { isExpiring, verifyAccessToken, type AccessClaims } from './jwt';
import { refreshSingleFlight } from './refresh';
import { safeNextPath } from './safe-next';

/**
 * `createAuthProxy(config)` for each app's `src/proxy.ts` (Next 16, Node runtime). A UX gate
 * only: the API is the authority (design §10).
 *
 * ```ts
 * // src/proxy.ts
 * import { createAuthProxy } from '@udemy/web-auth/proxy';
 * export const proxy = createAuthProxy(webAuthConfig); // a config, or () => config
 * export const config = {
 *   // Must be a literal (statically analysed); copy RECOMMENDED_PROXY_MATCHER.
 *   matcher: ['/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|woff2?)$).*)'],
 * };
 * ```
 *
 * Rules:
 * - `/verify-email`, `/reset-password`: always render, with `Referrer-Policy: no-referrer`
 *   (their links carry a token in the fragment).
 * - `loginPath`, `/signup`, `/forgot-password` (guest-only): a signed-in user (valid token for
 *   this app with `requiredRole`) is redirected to `homePath`. Anything else renders the page:
 *   no cookies (or cookies cleared by a BFF 401), an ended session (its cookies are cleared on
 *   the way), a user without the role, or an unknown status (API/JWKS down). This check is
 *   local, so it cannot see a session revoked on the server; that case cannot loop, because
 *   the BFF clears the cookies on the 401 that sends the client here (see ./api-proxy.ts).
 * - `publicPaths`: render; an expiring session is refreshed opportunistically so the header
 *   can show the user, but nothing is enforced.
 * - Everything else is protected:
 *   - missing/expiring `at` with an `rt`: refresh inline (single-flight), rewrite the REQUEST
 *     `Cookie` header via `NextResponse.next({ request: { headers } })` so the RSC render sees
 *     the new token, and Set-Cookie the new cookies on the response;
 *   - refresh rejected (or no session at all): clear the cookies, redirect to
 *     `loginPath?next=<safe path>`;
 *   - API/JWKS unreachable: redirect to login WITHOUT clearing cookies (a blip must not log
 *     anybody out);
 *   - token of another app (`app` claim): clear the cookies, redirect to login;
 *   - signed in without `requiredRole`: redirect to `forbiddenRedirect` (default
 *     `loginPath?error=forbidden`).
 * - `/api/*` is passed through untouched: the auth route handlers and the API proxy handle
 *   sessions themselves (so a request never refreshes twice).
 */

export const RECOMMENDED_PROXY_MATCHER =
  '/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|woff2?)$).*)';

const ALWAYS_RENDER: ReadonlySet<string> = new Set(['/verify-email', '/reset-password']);
const GUEST_ONLY_EXTRA = ['/signup', '/forgot-password'] as const;

export type AuthProxy = (request: NextRequest) => Promise<NextResponse>;

type Session =
  | { kind: 'signed-in'; claims: AccessClaims }
  | { kind: 'anonymous' }
  /** Refresh rejected or the token is for another app: cookies must be cleared. */
  | { kind: 'ended' }
  /** The API or JWKS was unreachable: status unknown, keep cookies. */
  | { kind: 'unknown' };

interface Resolution {
  session: Session;
  /** Set when a refresh produced new tokens (`newRefreshToken` absent on the grace path). */
  newAccessToken?: string;
  newRefreshToken?: string;
  setCookies: string[];
}

function matchesPublic(pathname: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      if (base === '') return true; // '/*' makes every page public
      return pathname === base || pathname.startsWith(`${base}/`);
    }
    return pathname === pattern;
  });
}

interface ProxySettings {
  config: WebAuthConfig;
  names: CookieNames;
  guestOnly: ReadonlySet<string>;
  forbiddenPathname: string;
}

export function createAuthProxy(source: WebAuthConfigSource): AuthProxy {
  const settings = lazyWithConfig(source, (config): ProxySettings => ({
    config,
    names: cookieNames(config),
    guestOnly: new Set<string>([
      new URL(config.loginPath, 'http://x.invalid').pathname,
      ...GUEST_ONLY_EXTRA,
    ]),
    forbiddenPathname: new URL(config.forbiddenRedirect, 'http://x.invalid').pathname,
  }));

  async function resolveSession(request: NextRequest): Promise<Resolution> {
    const { config } = settings();
    const { accessToken, refreshToken } = readAuthCookies(request, config);
    let current: AccessClaims | undefined;
    let unknown = false;

    if (accessToken) {
      const verified = await verifyAccessToken(config, accessToken);
      if (verified.kind === 'wrong-app') return { session: { kind: 'ended' }, setCookies: [] };
      if (verified.kind === 'valid') current = verified.claims;
      if (verified.kind === 'unavailable') unknown = true;
      if (current && !isExpiring(current.exp)) {
        return { session: { kind: 'signed-in', claims: current }, setCookies: [] };
      }
    }
    if (!refreshToken) {
      if (current) return { session: { kind: 'signed-in', claims: current }, setCookies: [] };
      return { session: unknown ? { kind: 'unknown' } : { kind: 'anonymous' }, setCookies: [] };
    }

    const outcome = await refreshSingleFlight(config, request, refreshToken);
    if (!outcome.ok) {
      if (outcome.reason === 'invalid') return { session: { kind: 'ended' }, setCookies: [] };
      // Keep using a still-valid (if expiring) token during an API blip.
      if (current) return { session: { kind: 'signed-in', claims: current }, setCookies: [] };
      return { session: { kind: 'unknown' }, setCookies: [] };
    }

    const setCookies = sessionSetCookies(config, outcome.result);
    const verified = await verifyAccessToken(config, outcome.result.accessToken);
    if (verified.kind === 'valid') {
      return {
        session: { kind: 'signed-in', claims: verified.claims },
        newAccessToken: outcome.result.accessToken,
        ...(outcome.result.refreshToken ? { newRefreshToken: outcome.result.refreshToken } : {}),
        setCookies,
      };
    }
    if (verified.kind === 'unavailable') return { session: { kind: 'unknown' }, setCookies };
    return { session: { kind: 'ended' }, setCookies: [] };
  }

  /** Continue to the route, making the refreshed/cleared cookies visible to this render. */
  function proceed(request: NextRequest, resolution: Resolution): NextResponse {
    const { config, names } = settings();
    const { session, newAccessToken, newRefreshToken, setCookies } = resolution;
    const ended = session.kind === 'ended';
    if (!newAccessToken && !ended) return NextResponse.next();

    const headers = new Headers(request.headers);
    const set: Record<string, string> = {};
    if (newAccessToken) set[names.access] = newAccessToken;
    if (newRefreshToken) set[names.refresh] = newRefreshToken;
    headers.set(
      'cookie',
      rewriteCookieHeader(request.headers.get('cookie'), {
        set,
        remove: ended ? [names.access, names.refresh] : [],
      }),
    );
    const response = NextResponse.next({ request: { headers } });
    appendCookies(response, ended ? clearSetCookies(config) : setCookies);
    return response;
  }

  function redirect(
    request: NextRequest,
    target: string,
    cookies: readonly string[],
  ): NextResponse {
    const response = NextResponse.redirect(new URL(target, request.nextUrl.href));
    response.headers.set('cache-control', 'no-store');
    appendCookies(response, cookies);
    return response;
  }

  function loginRedirect(request: NextRequest, resolution: Resolution): NextResponse {
    const { config } = settings();
    const here = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const next = safeNextPath(here);
    const target =
      next && next !== config.homePath
        ? `${config.loginPath}?next=${encodeURIComponent(next)}`
        : config.loginPath;
    // Clear whatever stale cookies there are, except when the API was merely unreachable.
    const { accessToken, refreshToken } = readAuthCookies(request, config);
    const stale = resolution.session.kind !== 'unknown' && (accessToken || refreshToken);
    return redirect(request, target, stale ? clearSetCookies(config) : []);
  }

  return async function authProxy(request) {
    const { pathname } = request.nextUrl;

    if (pathname === '/api' || pathname.startsWith('/api/')) return NextResponse.next();
    const { config, guestOnly, forbiddenPathname } = settings();

    if (ALWAYS_RENDER.has(pathname)) {
      const response = NextResponse.next();
      response.headers.set('referrer-policy', 'no-referrer');
      return response;
    }

    const isGuestOnly = guestOnly.has(pathname);
    const isPublic = isGuestOnly || matchesPublic(pathname, config.publicPaths);
    const { accessToken, refreshToken } = readAuthCookies(request, config);

    // Anonymous visitor on a public page: nothing to verify or refresh.
    if (isPublic && !accessToken && !refreshToken) return NextResponse.next();

    const resolution = await resolveSession(request);
    const { session } = resolution;
    const hasRole =
      session.kind === 'signed-in' && session.claims.roles.includes(config.requiredRole);

    if (isGuestOnly) {
      if (hasRole) return redirect(request, config.homePath, resolution.setCookies);
      return proceed(request, resolution);
    }
    if (isPublic) return proceed(request, resolution);

    // Protected page.
    if (session.kind !== 'signed-in') return loginRedirect(request, resolution);
    if (!hasRole && pathname !== forbiddenPathname) {
      return redirect(request, config.forbiddenRedirect, resolution.setCookies);
    }
    return proceed(request, resolution);
  };
}

function appendCookies(response: NextResponse, cookies: readonly string[]): void {
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
}
