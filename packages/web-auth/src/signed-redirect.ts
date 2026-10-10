import 'server-only';
import { ErrorCode, SignedUrlSchema } from '@udemy/contracts';
import { createApiProxyHandler, parseProxyPath } from './api-proxy';
import { lazyWithConfig, type WebAuthConfigSource } from './config';
import { NO_STORE, problemResponse } from './http';

/**
 * A stable, same-origin URL for an image or a download that 302s to a short-lived presigned
 * MinIO URL (design D11, §9 "Signed URL TTLs", §10).
 *
 * ```ts
 * // app/media/course-thumbnail/[courseId]/route.ts
 * export const GET = createSignedRedirectHandler(webAuthConfig, {
 *   apiPath: ({ params, searchParams }) =>
 *     isUuid(params.courseId)
 *       ? `/catalog/courses/${params.courseId}/images/thumbnail?variant=${...}`
 *       : null,
 * });
 * ```
 *
 * - The API answers `200 SignedUrl {url, expiresAt}` (contracts `SignedUrlSchema`). The call goes
 *   through `createApiProxyHandler`, so the same rules apply (client credentials, path
 *   re-encoding, token refresh, cookie clearing on a dead session).
 * - `session: 'none'` (default; thumbnails/posters for public and ISR pages): the visitor's
 *   cookies are NOT forwarded and the redirect is `public` (shared caches may keep it).
 *   `session: 'forward'` (downloads, owner previews): the session is forwarded and the redirect
 *   is `private`.
 * - The redirect target must be on `config.mediaOrigin` (`MEDIA_PUBLIC_ORIGIN`), https or http,
 *   without credentials; anything else is a 502 (never an open redirect).
 * - `Cache-Control` max-age = min(`maxAgeSeconds`, seconds until `expiresAt` − 30 s margin), so a
 *   cached redirect never points at an expired signature; `no-store` when that leaves nothing or
 *   the response sets cookies.
 * - `Referrer-Policy: no-referrer`: MinIO never learns which page embedded the URL.
 * - API errors (404, 403, 409 …) are passed on as `no-store` problem responses.
 */

export interface SignedRedirectContext<P> {
  params: P;
  searchParams: URLSearchParams;
}

export interface SignedRedirectOptions<P> {
  /**
   * API path (below `/api/v1`, starting with `/`, may carry a query), or `null` for a 404.
   * Validate the params (UUIDs, enums) here; segments are re-encoded either way.
   */
  apiPath: (context: SignedRedirectContext<P>) => string | null;
  /** Forward the visitor's session (`'forward'`) or call anonymously (`'none'`, default). */
  session?: 'none' | 'forward';
  /** Upper bound of the redirect's `max-age`. Default 300 s (design §9). */
  maxAgeSeconds?: number;
}

/** Next route handler signature (`params` is a Promise in Next 15+). */
export type SignedRedirectHandler<P> = (
  request: Request,
  context: { params: Promise<P> },
) => Promise<Response>;

/** Seconds of signature validity a cached redirect must leave to the browser. */
export const SIGNED_REDIRECT_SAFETY_MARGIN_S = 30;
const DEFAULT_MAX_AGE_S = 300;

/** The redirect target is acceptable: on `mediaOrigin`, no credentials. */
export function isAllowedMediaUrl(raw: string, mediaOrigin: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.origin !== mediaOrigin) return null;
  return url;
}

export function createSignedRedirectHandler<P = Record<string, string>>(
  source: WebAuthConfigSource,
  options: SignedRedirectOptions<P>,
): SignedRedirectHandler<P> {
  const session = options.session ?? 'none';
  const maxAge = Math.max(0, Math.floor(options.maxAgeSeconds ?? DEFAULT_MAX_AGE_S));
  const settings = lazyWithConfig(source, (config) => {
    if (!config.mediaOrigin) {
      throw new Error(
        'createSignedRedirectHandler needs mediaOrigin (MEDIA_PUBLIC_ORIGIN) in the web-auth config',
      );
    }
    return { config, mediaOrigin: config.mediaOrigin, proxy: createApiProxyHandler(config) };
  });

  return async function signedRedirect(request, context) {
    const { config, mediaOrigin, proxy } = settings();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problemResponse(405, 'method_not_allowed', 'Method not allowed', {
        headers: { allow: 'GET, HEAD' },
      });
    }

    const incoming = new URL(request.url);
    const apiPath = options.apiPath({
      params: await context.params,
      searchParams: incoming.searchParams,
    });
    const target = apiPath === null ? null : safeApiTarget(apiPath);
    if (target === null) return problemResponse(404, ErrorCode.NotFound);

    // Through the API proxy: one implementation of path safety, credentials and refresh.
    const headers = new Headers(request.headers);
    headers.set('accept', 'application/json');
    if (session === 'none') headers.delete('cookie');
    const upstream = await proxy(
      new Request(new URL(target, config.appOrigin), {
        method: 'GET',
        headers,
        signal: request.signal,
      }),
    );
    const setCookies = upstream.headers.getSetCookie();

    if (!upstream.ok) {
      const out = new Headers(upstream.headers);
      out.set('cache-control', NO_STORE);
      out.set('referrer-policy', 'no-referrer');
      out.delete('location');
      return new Response(request.method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers: out,
      });
    }

    const parsed = SignedUrlSchema.safeParse(await upstream.json().catch(() => undefined));
    const location = parsed.success ? isAllowedMediaUrl(parsed.data.url, mediaOrigin) : null;
    const expiresAtMs = parsed.success ? Date.parse(parsed.data.expiresAt) : Number.NaN;
    const secondsLeft = Math.floor((expiresAtMs - Date.now()) / 1000);
    if (!location || !Number.isFinite(secondsLeft) || secondsLeft <= 0) {
      // Never echo the URL: it is a bearer capability (and maybe not ours).
      return withCookies(
        problemResponse(502, ErrorCode.ServiceUnavailable, 'Unusable media URL from the API'),
        setCookies,
      );
    }

    const cacheSeconds = Math.min(maxAge, secondsLeft - SIGNED_REDIRECT_SAFETY_MARGIN_S);
    const cacheControl =
      cacheSeconds <= 0 || setCookies.length > 0
        ? NO_STORE
        : `${session === 'none' ? 'public' : 'private'}, max-age=${cacheSeconds}`;

    const out = new Headers({
      location: location.href,
      'cache-control': cacheControl,
      'referrer-policy': 'no-referrer',
    });
    if (session === 'forward') out.set('vary', 'cookie');
    return withCookies(new Response(null, { status: 302, headers: out }), setCookies);
  };
}

/**
 * `/api/proxy/<path>?<query>` for an app-built API path, or null when a segment is empty, a dot
 * segment (also `%2e%2e`), or contains `/`, `\` or control characters once decoded. Checked on
 * the raw string: the URL parser would otherwise resolve `..` and turn `\` into `/`.
 */
function safeApiTarget(apiPath: string): string | null {
  if (!apiPath.startsWith('/')) return null;
  const queryAt = apiPath.indexOf('?');
  const path = queryAt === -1 ? apiPath : apiPath.slice(0, queryAt);
  const query = queryAt === -1 ? '' : apiPath.slice(queryAt);
  const safe = parseProxyPath(`/api/proxy${path}`);
  return safe === null ? null : `/api/proxy/${safe}${query}`;
}

function withCookies(response: Response, setCookies: readonly string[]): Response {
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
  return response;
}
