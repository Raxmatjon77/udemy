'use client';

import {
  ProblemDetailsSchema,
  RealtimeTicketSchema,
  type ProblemDetails,
  type RealtimeTicket,
} from '@udemy/contracts';
import { REALTIME_TICKET_PATH } from '../realtime-ticket-path';
import { safeNextPath } from '../safe-next';

/**
 * Browser helpers. Tokens never reach this code: the browser only talks to its own Next
 * origin (`/api/auth/*`, `/api/proxy/*`) and the cookies are HttpOnly.
 */

export { isSafeNextPath, safeNextPath } from '../safe-next';
export { REALTIME_TICKET_PATH } from '../realtime-ticket-path';

/* ----------------------------------------------------------------------------------------
 * Cross-tab logout (BroadcastChannel('auth'))
 * -------------------------------------------------------------------------------------- */

export const AUTH_CHANNEL = 'auth';
/** `tabId` identifies the sending tab, so it can ignore its own message. */
export type AuthBroadcast = { type: 'logout'; tabId?: string };

// One id per tab (document), shared by every copy of this module that a bundle may contain.
const TAB_ID_KEY = Symbol.for('@udemy/web-auth/tab-id');

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** This tab's id (stable for the life of the document). */
export function tabId(): string {
  const holder = globalThis as unknown as Record<symbol, string | undefined>;
  return (holder[TAB_ID_KEY] ??= randomId());
}

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);
}

/** Tells every other tab of this origin that the user logged out. */
export function broadcastLogout(): void {
  const ch = channel();
  if (!ch) return;
  ch.postMessage({ type: 'logout', tabId: tabId() } satisfies AuthBroadcast);
  ch.close();
}

/**
 * Runs `onLogout` when ANOTHER tab logs out. Returns an unsubscribe function, so it fits
 * `useEffect(() => onLogoutBroadcast(() => router.replace('/login')), [router])`.
 *
 * A BroadcastChannel delivers to every other channel object, including the listener's own in
 * the tab that sent the message; that tab is already navigating to the login page itself
 * (`logout()`), so its own message (same `tabId`) is ignored.
 */
export function onLogoutBroadcast(onLogout: () => void): () => void {
  const ch = channel();
  if (!ch) return () => {};
  ch.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<AuthBroadcast> | null;
    if (data?.type === 'logout' && data.tabId !== tabId()) onLogout();
  };
  return () => ch.close();
}

/* ----------------------------------------------------------------------------------------
 * Errors
 * -------------------------------------------------------------------------------------- */

/**
 * `Retry-After` as seconds from now (delta-seconds or HTTP-date form), or null when absent or
 * unreadable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export interface ProxyFetchErrorOptions {
  /** The response headers (e.g. `Retry-After`, `X-Request-Id`). */
  headers?: HeadersInit;
  cause?: unknown;
}

/** A non-2xx answer from the BFF (`/api/proxy/*` or `/api/auth/*`). */
export class ProxyFetchError extends Error {
  /** The response headers (empty when the error was not built from a response). */
  readonly headers: Headers;
  /** `Retry-After` in seconds from when the error was created, or null. */
  readonly retryAfterSeconds: number | null;

  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
    options: ProxyFetchErrorOptions = {},
  ) {
    super(
      problem?.detail ?? problem?.title ?? `Request failed with status ${status}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ProxyFetchError';
    this.headers = new Headers(options.headers);
    this.retryAfterSeconds = parseRetryAfter(this.headers.get('retry-after'));
  }

  get code(): string | undefined {
    return this.problem?.code;
  }

  /** The raw `Retry-After` header (seconds or an HTTP date), or null. */
  get retryAfter(): string | null {
    return this.headers.get('retry-after');
  }

  /** Builds the error from a failed response (consumes its body), tolerating non-JSON bodies. */
  static async fromResponse(response: Response): Promise<ProxyFetchError> {
    return new ProxyFetchError(response.status, await readProblem(response), {
      headers: response.headers,
    });
  }
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }
  const parsed = ProblemDetailsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/* ----------------------------------------------------------------------------------------
 * Logout
 * -------------------------------------------------------------------------------------- */

/** How long `logout()` waits for `/api/auth/logout` before navigating anyway. */
const LOGOUT_TIMEOUT_MS = 5_000;

export interface LogoutOptions {
  /** Sign out every session of the user (`/api/auth/logout-all`). */
  all?: boolean;
  /** Default `/login`. */
  loginPath?: string;
}

/**
 * Ends the session, tells other tabs (`BroadcastChannel('auth')`) and navigates to the login
 * page (a full navigation, so all in-memory state such as the query cache is dropped).
 *
 * - `logout()` (this session) always completes locally: `/api/auth/logout` clears the cookies
 *   even when the API is down, and is only tried best-effort (bounded by a timeout); on a
 *   network error the browser goes to the login page anyway. Then the cookies may remain, and
 *   proxy.ts may still treat the browser as signed in until they expire.
 * - `logout({ all: true })` is a security action the user must be able to retry: it throws
 *   `ProxyFetchError` when the BFF reports a failure (a 401 means there is no session left,
 *   which counts as done), and rethrows network errors; nothing is broadcast then.
 */
export async function logout(options: LogoutOptions = {}): Promise<void> {
  const loginPath = options.loginPath ?? '/login';
  if (options.all) {
    const response = await fetch('/api/auth/logout-all', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok && response.status !== 401) {
      throw await ProxyFetchError.fromResponse(response);
    }
  } else {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        // Survives the navigation below should the timeout fire first.
        keepalive: true,
        signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
      });
    } catch {
      // Network error or timeout: still sign out locally (see above).
    }
  }
  broadcastLogout();
  window.location.assign(loginPath);
}

/* ----------------------------------------------------------------------------------------
 * fetch wrapper for /api/proxy/*
 * -------------------------------------------------------------------------------------- */

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

/**
 * JSON convenience on top of `createProxyFetch`: parsed body, or throws `ProxyFetchError`
 * (with the status, the parsed problem, the response headers and `retryAfterSeconds`).
 */
export function createProxyJson(options: ProxyFetchOptions = {}) {
  const proxyFetch = createProxyFetch(options);
  return async function proxyJson<T>(path: string, init: ProxyRequestInit = {}): Promise<T> {
    const response = await proxyFetch(path, init);
    if (!response.ok) throw await ProxyFetchError.fromResponse(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}

/* ----------------------------------------------------------------------------------------
 * Realtime ticket (Phase 5 D16)
 * -------------------------------------------------------------------------------------- */

/**
 * `POST /api/realtime/ticket` (`createRealtimeTicketHandler`): a single-use socket.io ticket for
 * the handshake `auth` payload. Call it before every (re)connect; a ticket lives 30 s.
 *
 * Throws `ProxyFetchError` on a non-2xx answer (401 signed out, 429 with `retryAfterSeconds`,
 * 503 `realtime_unavailable`: fall back to polling) and a 502 one when the body is not a
 * `RealtimeTicket`. Never redirects to login: realtime is an optional enhancement.
 */
export async function fetchRealtimeTicket(
  init: { signal?: AbortSignal } = {},
): Promise<RealtimeTicket> {
  const response = await fetch(REALTIME_TICKET_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!response.ok) throw await ProxyFetchError.fromResponse(response);
  const parsed = RealtimeTicketSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ProxyFetchError(502, null, { cause: parsed.error });
  return parsed.data;
}
