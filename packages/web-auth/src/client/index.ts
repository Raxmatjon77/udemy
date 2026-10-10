'use client';

import type { ProblemDetails } from '@udemy/contracts';
import { safeNextPath } from '../safe-next';

/**
 * Browser helpers. Tokens never reach this code: the browser only talks to its own Next
 * origin (`/api/auth/*`, `/api/proxy/*`) and the cookies are HttpOnly.
 */

export { isSafeNextPath, safeNextPath } from '../safe-next';

/* ----------------------------------------------------------------------------------------
 * Cross-tab logout (BroadcastChannel('auth'))
 * -------------------------------------------------------------------------------------- */

export const AUTH_CHANNEL = 'auth';
export type AuthBroadcast = { type: 'logout' };

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);
}

/** Tells every other tab of this origin that the user logged out. */
export function broadcastLogout(): void {
  const ch = channel();
  if (!ch) return;
  ch.postMessage({ type: 'logout' } satisfies AuthBroadcast);
  ch.close();
}

/**
 * Runs `onLogout` when another tab logs out. Returns an unsubscribe function, so it fits
 * `useEffect(() => onLogoutBroadcast(() => router.replace('/login')), [router])`.
 */
export function onLogoutBroadcast(onLogout: () => void): () => void {
  const ch = channel();
  if (!ch) return () => {};
  ch.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<AuthBroadcast> | null;
    if (data?.type === 'logout') onLogout();
  };
  return () => ch.close();
}

/* ----------------------------------------------------------------------------------------
 * fetch wrapper for /api/proxy/*
 * -------------------------------------------------------------------------------------- */

export class ProxyFetchError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with ${status}`);
    this.name = 'ProxyFetchError';
  }
  get code(): string | undefined {
    return this.problem?.code;
  }
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  try {
    const body = (await response.json()) as ProblemDetails | null;
    return typeof body === 'object' && body !== null && typeof body.status === 'number'
      ? body
      : null;
  } catch {
    return null;
  }
}

/**
 * POSTs to `/api/auth/logout` (or `logout-all`), broadcasts to other tabs and navigates to
 * the login page. Logout always succeeds locally (the BFF clears the cookies even if the API
 * is down); logout-all throws `ProxyFetchError` on failure so the UI can say so.
 */
export async function logout(options: { all?: boolean; loginPath?: string } = {}): Promise<void> {
  const response = await fetch(options.all ? '/api/auth/logout-all' : '/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (options.all && !response.ok && response.status !== 401) {
    throw new ProxyFetchError(response.status, await readProblem(response));
  }
  broadcastLogout();
  window.location.assign(options.loginPath ?? '/login');
}

export interface ProxyFetchOptions {
  /** Default `/api/proxy`. */
  basePath?: string;
  /** Default `/login`. */
  loginPath?: string;
  /**
   * Called when the session is gone (a 401 a retry cannot fix). Default: navigate to
   * `loginPath?next=<current path>`.
   */
  onUnauthorized?: () => void;
}

export interface ProxyRequestInit extends RequestInit {
  /** JSON body; sets `Content-Type: application/json`. Takes precedence over `body`. */
  json?: unknown;
}

export function redirectToLogin(loginPath = '/login'): void {
  const next = safeNextPath(`${window.location.pathname}${window.location.search}`);
  window.location.assign(
    next && next !== '/' ? `${loginPath}?next=${encodeURIComponent(next)}` : loginPath,
  );
}

/**
 * `fetch` for the BFF proxy: `proxyFetch('/me/profile')` → `GET /api/proxy/me/profile`.
 *
 * - Sends JSON with `Content-Type: application/json` (the BFF requires it on unsafe methods)
 *   and same-origin credentials. The browser adds `Origin` itself.
 * - 401 `token_expired`: the BFF has just refreshed the cookies but could not replay a
 *   streamed body; retry once.
 * - Any other 401: the session is gone → `onUnauthorized` (default: redirect to login).
 *
 * Returns the raw `Response` (usable as an orval mutator), or see `createProxyJson`.
 */
export function createProxyFetch(options: ProxyFetchOptions = {}) {
  const basePath = options.basePath ?? '/api/proxy';
  const loginPath = options.loginPath ?? '/login';
  const onUnauthorized = options.onUnauthorized ?? (() => redirectToLogin(loginPath));

  return async function proxyFetch(path: string, init: ProxyRequestInit = {}): Promise<Response> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    let body = rest.body ?? null;
    if (json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(json);
    }
    const url = `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
    const send = () => fetch(url, { ...rest, headers, body, credentials: 'same-origin' });
    const replayable = body === null || typeof body === 'string';

    let response = await send();
    if (response.status === 401) {
      const problem = await readProblem(response.clone());
      if (problem?.code === 'token_expired' && replayable) response = await send();
      if (response.status === 401) onUnauthorized();
    }
    return response;
  };
}

/** JSON convenience on top of `createProxyFetch`: parsed body, or throws `ProxyFetchError`. */
export function createProxyJson(options: ProxyFetchOptions = {}) {
  const proxyFetch = createProxyFetch(options);
  return async function proxyJson<T>(path: string, init: ProxyRequestInit = {}): Promise<T> {
    const response = await proxyFetch(path, init);
    if (!response.ok) throw new ProxyFetchError(response.status, await readProblem(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}
