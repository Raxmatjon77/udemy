import 'server-only';
import { ErrorCode, RealtimeTicketSchema } from '@udemy/contracts';
import { createApiProxyHandler } from './api-proxy';
import { lazyWithConfig, type WebAuthConfigSource } from './config';
import { readAuthCookies } from './cookies';
import { checkOrigin, NO_STORE, problemResponse } from './http';
import { REALTIME_TICKET_PATH } from './realtime-ticket-path';
import type { RouteHandler } from './route-handlers';

/**
 * `POST /api/realtime/ticket` (`REALTIME_TICKET_PATH`; Phase 5 learning experience design §10, D16): the browser's only
 * way to get a socket.io ticket. Mounted by every app:
 *
 * ```ts
 * // app/api/realtime/ticket/route.ts
 * export const POST = createRealtimeTicketHandler(webAuthConfig);
 * ```
 *
 * - CSRF: the same Origin rule as every unsafe BFF call (`Origin` = `APP_ORIGIN`, or
 *   `Sec-Fetch-Site: same-origin`); a request body is ignored, never forwarded.
 * - No session cookie at all: 401 `unauthorized` without calling the api (tickets are
 *   `@AuthenticatedOnly`).
 * - The call is `POST /api/v1/realtime/tickets` through `createApiProxyHandler`, so the client
 *   credentials, the token refresh (< 30 s left, or a `token_expired` retry) and the cookie
 *   clearing on a dead session behave exactly like `/api/proxy/*`.
 * - Success: `201 RealtimeTicket` (`{ticket, url, expiresAt}`, the api's body re-validated with
 *   the contracts schema), `Cache-Control: no-store`. An unusable body (schema mismatch, or a
 *   `url` that is not `REALTIME_PUBLIC_URL` when the BFF has one: the CSP would block the socket
 *   anyway) is 502 `service_unavailable`; the ticket is never echoed in that case.
 * - API problems (401, 429 `rate_limited` with `Retry-After`, 503 `realtime_unavailable`) are
 *   passed on as `no-store` problem responses; the client falls back to polling.
 */

export { REALTIME_TICKET_PATH };
const API_TICKETS_PATH = '/api/proxy/realtime/tickets';

/** Request headers that never go up (the ticket call has no body). */
const DROPPED_HEADERS = ['content-type', 'content-length', 'transfer-encoding'] as const;

/** `ws(s)://host` and `http(s)://host` name the same socket.io origin. */
function httpOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.origin;
  } catch {
    return null;
  }
}

export type RealtimeTicketHandler = RouteHandler;

export function createRealtimeTicketHandler(source: WebAuthConfigSource): RealtimeTicketHandler {
  const settings = lazyWithConfig(source, (config) => ({
    config,
    proxy: createApiProxyHandler(config),
  }));

  return async function realtimeTicket(request) {
    const { config, proxy } = settings();
    if (request.method.toUpperCase() !== 'POST') {
      return problemResponse(405, 'method_not_allowed', 'Method not allowed', {
        headers: { allow: 'POST' },
      });
    }
    const rejected = checkOrigin(request, config);
    if (rejected) return rejected;

    const cookies = readAuthCookies(request, config);
    if (!cookies.accessToken && !cookies.refreshToken) {
      return problemResponse(401, ErrorCode.Unauthorized, 'Not signed in');
    }

    // Through the API proxy: one implementation of credentials, refresh and session clearing.
    // The Origin was checked above; the inner request carries the app's own origin.
    const headers = new Headers(request.headers);
    for (const name of DROPPED_HEADERS) headers.delete(name);
    headers.set('accept', 'application/json');
    headers.set('origin', config.appOrigin);
    const upstream = await proxy(
      new Request(new URL(API_TICKETS_PATH, config.appOrigin), {
        method: 'POST',
        headers,
        signal: request.signal,
      }),
    );
    const setCookies = upstream.headers.getSetCookie();

    if (!upstream.ok) {
      const out = new Headers(upstream.headers);
      out.set('cache-control', NO_STORE);
      out.delete('location');
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    const parsed = RealtimeTicketSchema.safeParse(await upstream.json().catch(() => undefined));
    const expected = config.realtimeOrigin;
    const usable =
      parsed.success && (expected === undefined || httpOrigin(parsed.data.url) === expected);
    if (!parsed.success || !usable) {
      return withCookies(
        problemResponse(502, ErrorCode.ServiceUnavailable, 'Unusable realtime ticket from the API'),
        setCookies,
      );
    }

    const { ticket, url, expiresAt } = parsed.data;
    return withCookies(
      new Response(JSON.stringify({ ticket, url, expiresAt }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'cache-control': NO_STORE },
      }),
      setCookies,
    );
  };
}

function withCookies(response: Response, setCookies: readonly string[]): Response {
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
  return response;
}
