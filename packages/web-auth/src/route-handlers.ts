import 'server-only';
import { ErrorCode, LoginRequestSchema, type AuthUser } from '@udemy/contracts';
import { ApiProblemError, apiLogin, apiLogout, apiLogoutAll } from './api-client';
import { defineWebAuthConfig, type WebAuthConfig, type WebAuthConfigInput } from './config';
import { clearSessionCookies, readAuthCookies, setSessionCookies } from './cookies';
import {
  BodyTooLargeError,
  checkJsonBody,
  checkOrigin,
  forwardProblem,
  NO_STORE,
  problemResponse,
  readBodyBytes,
} from './http';
import { secondsLeft, REFRESH_THRESHOLD_S } from './jwt';
import { refreshSingleFlight } from './refresh';

/**
 * BFF auth route handlers (design §9): the only code that ever sees refresh tokens.
 *
 * ```ts
 * // app/api/auth/login/route.ts
 * export const { login: POST } = authRoutes;
 * ```
 *
 * All are POST-only (Next answers 405 for other methods when only POST is exported) and
 * enforce the Origin rule. No handler ever returns a token in a body.
 */

const LOGIN_BODY_LIMIT = 16 * 1024;

export interface LoginResponseBody {
  user: AuthUser;
}

export interface RefreshResponseBody {
  accessTokenExpiresAt: string;
}

export type RouteHandler = (request: Request) => Promise<Response>;

export interface AuthRouteHandlers {
  /** `POST /api/auth/login` `{ email, password }` → 200 `{ user }` + Set-Cookie at, rt. */
  login: RouteHandler;
  /** `POST /api/auth/logout` → 204 + cleared cookies, always (even if the API fails). */
  logout: RouteHandler;
  /** `POST /api/auth/logout-all` → 204 + cleared cookies; 401/503 problems on failure. */
  logoutAll: RouteHandler;
  /** `POST /api/auth/refresh` → 200 `{ accessTokenExpiresAt }` + Set-Cookie (rotated). */
  refresh: RouteHandler;
}

function json(body: unknown, status = 200, headers?: Headers): Response {
  const out = headers ?? new Headers();
  out.set('content-type', 'application/json');
  out.set('cache-control', NO_STORE);
  return new Response(JSON.stringify(body), { status, headers: out });
}

function noContent(headers: Headers): Response {
  headers.set('cache-control', NO_STORE);
  return new Response(null, { status: 204, headers });
}

function upstreamFailure(error: unknown): Response {
  if (error instanceof ApiProblemError) {
    const headers = new Headers();
    if (error.retryAfter) headers.set('retry-after', error.retryAfter);
    return forwardProblem(error.problem, headers);
  }
  // ApiUnavailableError (network, timeout, 5xx, contract mismatch): never leak details.
  return problemResponse(503, ErrorCode.ServiceUnavailable, 'The API is unavailable');
}

export function createAuthRouteHandlers(
  input: WebAuthConfigInput | WebAuthConfig,
): AuthRouteHandlers {
  const config = defineWebAuthConfig(input);

  const login: RouteHandler = async (request) => {
    const rejected = checkOrigin(request, config) ?? checkJsonBody(request);
    if (rejected) return rejected;

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(await readBodyBytes(request, LOGIN_BODY_LIMIT)));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return problemResponse(413, ErrorCode.ValidationFailed, 'Request body too large');
      }
      return problemResponse(400, ErrorCode.ValidationFailed, 'Body must be JSON');
    }
    const parsed = LoginRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return problemResponse(400, ErrorCode.ValidationFailed, 'Invalid email or password format');
    }

    try {
      const result = await apiLogin(config, request, parsed.data);
      const headers = new Headers();
      setSessionCookies(headers, config, result);
      const body: LoginResponseBody = { user: result.user };
      return json(body, 200, headers);
    } catch (error) {
      return upstreamFailure(error);
    }
  };

  const logout: RouteHandler = async (request) => {
    const rejected = checkOrigin(request, config);
    if (rejected) return rejected;
    const { refreshToken } = readAuthCookies(request, config);
    if (refreshToken) {
      try {
        await apiLogout(config, request, refreshToken);
      } catch {
        // Logout is best effort upstream: the cookies are cleared regardless, and the session
        // expires on its own (idle/absolute expiry) if the API never saw this call.
      }
    }
    const headers = new Headers();
    clearSessionCookies(headers, config);
    return noContent(headers);
  };

  const logoutAll: RouteHandler = async (request) => {
    const rejected = checkOrigin(request, config);
    if (rejected) return rejected;
    let { accessToken } = readAuthCookies(request, config);
    const { refreshToken } = readAuthCookies(request, config);
    const headers = new Headers();

    if ((!accessToken || secondsLeft(accessToken) < REFRESH_THRESHOLD_S) && refreshToken) {
      const outcome = await refreshSingleFlight(config, request, refreshToken);
      if (outcome.ok) {
        accessToken = outcome.result.accessToken;
      } else if (outcome.reason === 'invalid') {
        clearSessionCookies(headers, config);
        return problemResponse(401, ErrorCode.Unauthorized, 'Session expired', { headers });
      } else {
        return problemResponse(503, ErrorCode.ServiceUnavailable, 'The API is unavailable');
      }
    }
    if (!accessToken) {
      clearSessionCookies(headers, config);
      return problemResponse(401, ErrorCode.Unauthorized, 'Not signed in', { headers });
    }

    try {
      await apiLogoutAll(config, request, accessToken);
    } catch (error) {
      // Unlike logout, this is a security action the user must be able to retry: keep the
      // cookies on a transient failure and report it. A 401 means there is no session left.
      if (error instanceof ApiProblemError && error.status === 401) {
        clearSessionCookies(headers, config);
        return problemResponse(401, ErrorCode.Unauthorized, 'Session expired', { headers });
      }
      return upstreamFailure(error);
    }
    clearSessionCookies(headers, config);
    return noContent(headers);
  };

  const refresh: RouteHandler = async (request) => {
    const rejected = checkOrigin(request, config);
    if (rejected) return rejected;
    const { refreshToken } = readAuthCookies(request, config);
    const headers = new Headers();
    if (!refreshToken) {
      clearSessionCookies(headers, config);
      return problemResponse(401, ErrorCode.InvalidRefreshToken, 'No session', { headers });
    }
    const outcome = await refreshSingleFlight(config, request, refreshToken);
    if (!outcome.ok) {
      if (outcome.reason === 'unavailable') {
        return problemResponse(503, ErrorCode.ServiceUnavailable, 'The API is unavailable');
      }
      clearSessionCookies(headers, config);
      return problemResponse(401, ErrorCode.InvalidRefreshToken, 'Session expired', { headers });
    }
    // Grace path (no new rt): only the at cookie is set; the browser keeps its rt cookie.
    setSessionCookies(headers, config, outcome.result);
    const body: RefreshResponseBody = { accessTokenExpiresAt: outcome.result.accessTokenExpiresAt };
    return json(body, 200, headers);
  };

  return { login, logout, logoutAll, refresh };
}
