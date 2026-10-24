/**
 * `@udemy/web-auth`: the BFF auth layer shared by the Next apps (design §9/§10).
 *
 * Server-only (every module imports `server-only`). Entries:
 * - `@udemy/web-auth`           config, cookies, API client, auth route handlers, API proxy,
 *                               signed media redirects, CSP builder, realtime ticket route
 * - `@udemy/web-auth/proxy`     `createAuthProxy` for `src/proxy.ts`
 * - `@udemy/web-auth/session`   `createGetSession` for server components (uses next/headers)
 * - `@udemy/web-auth/client`    `'use client'` helpers (logout broadcast, proxy fetch)
 * - `@udemy/web-auth/safe-next` isomorphic `next` param validation
 */
import 'server-only';

export { defineWebAuthConfig, lazyWebAuthConfig, WebAuthConfigSchema } from './config';
export type {
  ClientIpResolver,
  WebAuthConfig,
  WebAuthConfigInput,
  WebAuthConfigSource,
} from './config';
export {
  ACCESS_COOKIE_MAX_AGE_S,
  clearSessionCookies,
  clearSetCookies,
  cookieNames,
  readAuthCookies,
  serializeCookie,
  sessionSetCookies,
  setSessionCookies,
} from './cookies';
export type { CookieNames, SessionCookieTokens } from './cookies';
export {
  ApiProblemError,
  ApiUnavailableError,
  apiFetch,
  apiLogin,
  apiLogout,
  apiLogoutAll,
  apiRefresh,
  readProblem,
  resolveClientIp,
} from './api-client';
export { createAuthRouteHandlers } from './route-handlers';
export type {
  AuthRouteHandlers,
  LoginResponseBody,
  RefreshResponseBody,
  RouteHandler,
} from './route-handlers';
export { createApiProxyHandler, FORWARDED_RESPONSE_HEADERS } from './api-proxy';
export type { ApiProxyHandler } from './api-proxy';
export {
  createSignedRedirectHandler,
  isAllowedMediaUrl,
  SIGNED_REDIRECT_SAFETY_MARGIN_S,
} from './signed-redirect';
export type {
  SignedRedirectContext,
  SignedRedirectHandler,
  SignedRedirectOptions,
} from './signed-redirect';
export { buildContentSecurityPolicy, createNonce } from './csp';
export { createRealtimeTicketHandler, REALTIME_TICKET_PATH } from './realtime-ticket';
export type { RealtimeTicketHandler } from './realtime-ticket';
export type { CspInput } from './csp';
export { refreshSingleFlight } from './refresh';
export type { RefreshOutcome } from './refresh';
export { verifyAccessToken, REFRESH_THRESHOLD_S } from './jwt';
export type { AccessClaims, VerifyResult } from './jwt';
export { isSafeNextPath, safeNextPath } from './safe-next';
