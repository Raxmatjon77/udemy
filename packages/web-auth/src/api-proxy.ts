import 'server-only';
import { ErrorCode, ProblemDetailsSchema } from '@udemy/contracts';
import { ApiUnavailableError, apiFetch } from './api-client';
import { lazyWebAuthConfig, type WebAuthConfig, type WebAuthConfigSource } from './config';
import {
  clearSetCookies,
  clearSessionCookies,
  readAuthCookies,
  sessionSetCookies,
} from './cookies';
import {
  BodyTooLargeError,
  checkJsonBody,
  checkOrigin,
  hasRequestBody,
  limitStream,
  NO_STORE,
  problemResponse,
  readBodyBytes,
  UNSAFE_METHODS,
} from './http';
import { REFRESH_THRESHOLD_S, secondsLeft } from './jwt';
import { refreshSingleFlight, type RefreshOutcome } from './refresh';

/**
 * `ALL /api/proxy/[...path]` → `API_INTERNAL_URL/api/v1/<path>` with Bearer `at` (design §9).
 *
 * ```ts
 * // app/api/proxy/[...path]/route.ts
 * const handler = createApiProxyHandler(webAuthConfig); // a config, or () => config
 * export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
 * ```
 *
 * - Denies `auth/login`, `auth/refresh`, `auth/logout` (404): their bodies carry refresh tokens.
 * - Unsafe methods: Origin rule + `Content-Type: application/json` when there is a body.
 * - Only allowlisted request headers go up and allowlisted response headers come back;
 *   upstream `set-cookie` is never forwarded.
 * - Refreshes first when `at` has < 30 s left; on an upstream `401 token_expired` refreshes once
 *   and retries. Refreshes are single-flight per process (see ./refresh.ts).
 * - Bodies are streamed. Small bodies (known length ≤ 64 KiB, i.e. every normal JSON call) are
 *   buffered so the retry can replay them; a larger or chunked body is streamed (capped at
 *   `maxProxyBodyBytes`) and cannot be replayed: on `token_expired` the BFF still refreshes
 *   (new cookies) and returns the 401 `token_expired`, which the client helper retries once.
 * - Session ended upstream: when the API rejects the request made with our access token with
 *   401 `unauthorized` (revoked sid: logout-all, password reset, ban, refresh-token reuse;
 *   checked after the token_expired refresh-and-retry) or with a `token_expired` that cannot be
 *   fixed (already refreshed once, or no refresh token), or a refresh is rejected
 *   (`invalid_refresh_token`), the 401 goes back WITH both cookies cleared. Otherwise the
 *   browser would keep a dead but locally valid access JWT, and proxy.ts would keep treating
 *   it as signed in (bouncing `/login` to home) until it expired.
 * - Transient failures (API unreachable, timeouts, 5xx, 503 `service_unavailable`) never clear
 *   cookies: a blip must not log anybody out.
 */

const DENIED_PATHS: ReadonlySet<string> = new Set(['auth/login', 'auth/refresh', 'auth/logout']);
const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', ...UNSAFE_METHODS]);
const PROXY_PREFIX = '/api/proxy/';
const REPLAYABLE_BODY_LIMIT = 64 * 1024;

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'idempotency-key',
] as const;

/** Response headers the browser may see. Notably absent: set-cookie, content-length/encoding
 * (the body is re-streamed, already decoded by fetch), server, x-powered-by.
 * Non-JSON bodies pass through unchanged with their type and cache headers: the HLS playlists
 * (`application/vnd.apple.mpegurl`, `Cache-Control: private, no-store`) are streamed as is, and
 * their relative variant URIs resolve back through this proxy. */
export const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-language',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'location',
  'ratelimit-limit',
  'ratelimit-policy',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'vary',
  'x-request-id',
] as const;

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Turns the part after `/api/proxy/` into a safe, re-encoded API path, or `null` when any
 * segment is empty, `.`/`..`, or decodes to something containing `/`, `\` or control chars.
 */
export function parseProxyPath(pathname: string): string | null {
  const start = pathname.indexOf(PROXY_PREFIX);
  if (start === -1) return null;
  const rest = pathname.slice(start + PROXY_PREFIX.length);
  if (rest.length === 0) return null;
  const segments: string[] = [];
  for (const raw of rest.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded === '' || decoded === '.' || decoded === '..') return null;
    if (decoded.includes('/') || decoded.includes('\\') || CONTROL_CHARS.test(decoded)) return null;
    segments.push(encodeURIComponent(decoded));
  }
  return segments.join('/');
}

function rewriteLocation(location: string, config: WebAuthConfig): string | null {
  const apiPrefix = '/api/v1/';
  if (location.startsWith(apiPrefix)) return PROXY_PREFIX + location.slice(apiPrefix.length);
  const absolutePrefix = `${config.apiInternalUrl}${apiPrefix}`;
  if (location.startsWith(absolutePrefix)) {
    return PROXY_PREFIX + location.slice(absolutePrefix.length);
  }
  return null; // never point the browser at the internal API
}

function responseHeaders(upstream: Headers, config: WebAuthConfig): Headers {
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value === null) continue;
    if (name === 'location') {
      const rewritten = rewriteLocation(value, config);
      if (rewritten) out.set(name, rewritten);
      continue;
    }
    out.set(name, value);
  }
  if (!out.has('cache-control')) out.set('cache-control', NO_STORE);
  return out;
}

type BodyPlan =
  | { kind: 'none' }
  | { kind: 'buffered'; bytes: Uint8Array }
  | { kind: 'stream'; stream: ReadableStream<Uint8Array> };

async function planBody(request: Request, config: WebAuthConfig): Promise<BodyPlan> {
  if (request.method === 'GET' || request.method === 'HEAD' || !hasRequestBody(request)) {
    return { kind: 'none' };
  }
  const declared = request.headers.get('content-length');
  const length = declared === null ? null : Number(declared);
  if (length !== null && length > config.maxProxyBodyBytes) {
    throw new BodyTooLargeError(config.maxProxyBodyBytes);
  }
  if (length !== null && length <= REPLAYABLE_BODY_LIMIT) {
    return { kind: 'buffered', bytes: await readBodyBytes(request, REPLAYABLE_BODY_LIMIT) };
  }
  return {
    kind: 'stream',
    stream: request.body!.pipeThrough(limitStream(config.maxProxyBodyBytes)),
  };
}

export type ApiProxyHandler = (request: Request) => Promise<Response>;

export function createApiProxyHandler(source: WebAuthConfigSource): ApiProxyHandler {
  const getConfig = lazyWebAuthConfig(source);

  return async function apiProxy(request) {
    const config = getConfig();
    const method = request.method.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      return problemResponse(405, 'method_not_allowed', 'Method not allowed', {
        headers: { allow: [...ALLOWED_METHODS].join(', ') },
      });
    }
    const apiPath = parseProxyPath(new URL(request.url).pathname);
    if (!apiPath || DENIED_PATHS.has(apiPath.toLowerCase())) {
      return problemResponse(404, ErrorCode.NotFound);
    }
    if (UNSAFE_METHODS.has(method)) {
      const rejected = checkOrigin(request, config) ?? checkJsonBody(request);
      if (rejected) return rejected;
    }

    let body: BodyPlan;
    try {
      body = await planBody(request, config);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return problemResponse(413, ErrorCode.ValidationFailed, 'Request body too large');
      }
      throw error;
    }

    const cookieUpdates: string[] = [];
    const cookies = readAuthCookies(request, config);
    let accessToken = cookies.accessToken;
    const refreshToken = cookies.refreshToken;
    let refreshed = false;
    /** A refresh in this request produced a new access token (so a token_expired is final). */
    let refreshSucceeded = false;

    /** Applies a refresh outcome; returns an error response when the request must stop. */
    const applyRefresh = (outcome: RefreshOutcome, canFallBack: boolean): Response | null => {
      refreshed = true;
      if (outcome.ok) {
        refreshSucceeded = true;
        accessToken = outcome.result.accessToken;
        cookieUpdates.push(...sessionSetCookies(config, outcome.result));
        return null;
      }
      if (outcome.reason === 'invalid') {
        const headers = new Headers();
        clearSessionCookies(headers, config);
        return problemResponse(401, ErrorCode.Unauthorized, 'Session expired', { headers });
      }
      // API unreachable: keep the cookies; continue with a still-valid at if there is one.
      return canFallBack
        ? null
        : problemResponse(503, ErrorCode.ServiceUnavailable, 'The API is unavailable');
    };

    if (refreshToken && (!accessToken || secondsLeft(accessToken) < REFRESH_THRESHOLD_S)) {
      const stillValid = !!accessToken && secondsLeft(accessToken) > 0;
      const stop = applyRefresh(
        await refreshSingleFlight(config, request, refreshToken),
        stillValid,
      );
      if (stop) return stop;
    }

    const forwardHeaders = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) forwardHeaders.set(name, value);
    }
    const target = `/${apiPath}${new URL(request.url).search}`;

    const send = (bodyInit: BodyPlan) =>
      apiFetch(config, target, request, {
        method,
        headers: forwardHeaders,
        ...(accessToken ? { accessToken } : {}),
        ...(bodyInit.kind === 'buffered' ? { body: bodyInit.bytes as BodyInit } : {}),
        ...(bodyInit.kind === 'stream' ? { body: bodyInit.stream, duplex: 'half' as const } : {}),
      });

    let upstream: Response;
    try {
      upstream = await send(body);

      if (upstream.status === 401 && refreshToken && !refreshed) {
        const text = await upstream.text();
        if (problemCode(text) === ErrorCode.TokenExpired) {
          const stop = applyRefresh(
            await refreshSingleFlight(config, request, refreshToken),
            false,
          );
          if (stop) return stop;
          if (body.kind === 'stream') {
            // The streamed body is consumed; let the client retry with the fresh cookies.
            return finish(
              problemResponse(401, ErrorCode.TokenExpired, 'Retry the request'),
              cookieUpdates,
            );
          }
          upstream = await send(body);
        } else {
          upstream = new Response(text, { status: upstream.status, headers: upstream.headers });
        }
      }
    } catch (error) {
      if (error instanceof ApiUnavailableError && error.cause instanceof BodyTooLargeError) {
        return problemResponse(413, ErrorCode.ValidationFailed, 'Request body too large');
      }
      if (error instanceof ApiUnavailableError && request.signal.aborted) {
        return new Response(null, { status: 499 }); // client went away; nobody reads this
      }
      if (error instanceof ApiUnavailableError) {
        return finish(
          problemResponse(502, ErrorCode.ServiceUnavailable, 'The API is unavailable'),
          cookieUpdates,
        );
      }
      throw error;
    }

    // The API rejected our access token for good (revoked session, or a token_expired that the
    // refresh-and-retry above could not fix): end the browser session too, because the client
    // sends every final 401 to the login page, and a login page that still sees a locally valid
    // access cookie bounces back home (redirect loop). Anonymous requests have no session to end.
    if (upstream.status === 401 && accessToken) {
      // An unreadable body (connection dropped) has no code: treat it as transient.
      const text = await upstream.text().catch(() => '');
      const code = problemCode(text);
      const rejected =
        code === ErrorCode.Unauthorized ||
        (code === ErrorCode.TokenExpired && (refreshSucceeded || !refreshToken));
      const replay = new Response(text, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers, config),
      });
      // Clearing replaces any cookies a refresh in this request set: the session is over.
      return finish(replay, rejected ? clearSetCookies(config) : cookieUpdates);
    }

    const headers = responseHeaders(upstream.headers, config);
    const streamBody =
      method === 'HEAD' || NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body;
    if (streamBody === null) await upstream.body?.cancel();
    return finish(
      new Response(streamBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      }),
      cookieUpdates,
    );
  };
}

/** The `code` of a problem+json body, or undefined for anything else. */
function problemCode(text: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ProblemDetailsSchema.safeParse(raw);
  return parsed.success ? parsed.data.code : undefined;
}

/** Adds Set-Cookie values; rebuilds the response so it never mutates possibly-immutable headers. */
function finish(response: Response, setCookies: readonly string[]): Response {
  if (setCookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
