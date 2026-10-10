import 'server-only';
import { ErrorCode, type RefreshResult } from '@udemy/contracts';
import { ApiProblemError, apiRefresh } from './api-client';
import type { WebAuthConfig } from './config';

/**
 * In-process single-flight refresh (design §10).
 *
 * Concurrent requests carrying the same refresh token (a page with several client queries,
 * an RSC render plus a client fetch, ...) share ONE `POST /auth/refresh`. The in-flight map
 * is keyed by `sha256(rt)` so raw refresh tokens are never used as map keys, and an entry
 * lives only while its call is in flight.
 *
 * Limits: the map is per Node process. Several Next instances (pods), or a late request that
 * arrives after the first refresh settled but before the browser stored the rotated cookie,
 * send the OLD token again. The API covers that with its 10 s reuse-grace path: it answers
 * with an access token only (no new rt), and the BFF then leaves the rt cookie untouched.
 */

export type RefreshOutcome =
  | { ok: true; result: RefreshResult }
  /** The API rejected the token (`invalid_refresh_token`, or any 4xx): the session is over. */
  | { ok: false; reason: 'invalid' }
  /** Network error, timeout, 5xx: the session may still be fine; do not clear cookies. */
  | { ok: false; reason: 'unavailable' };

// Shared across module copies in the same process (route handlers and proxy.ts may be
// bundled separately), hence a global registered symbol rather than a module-level Map.
const INFLIGHT_KEY = Symbol.for('@udemy/web-auth/refresh-inflight');
type InflightMap = Map<string, Promise<RefreshOutcome>>;

function inflightMap(): InflightMap {
  const holder = globalThis as unknown as Record<symbol, InflightMap | undefined>;
  return (holder[INFLIGHT_KEY] ??= new Map());
}

export async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function callRefresh(
  config: WebAuthConfig,
  incoming: Request,
  refreshToken: string,
): Promise<RefreshOutcome> {
  try {
    return { ok: true, result: await apiRefresh(config, incoming, refreshToken) };
  } catch (error) {
    if (error instanceof ApiProblemError && error.status < 500) {
      // 401 invalid_refresh_token is the documented case; any other 4xx (400 shape, 403
      // banned/app access) equally means this refresh token cannot be used again.
      return { ok: false, reason: 'invalid' };
    }
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Refreshes with `refreshToken`, joining an in-flight refresh for the same token if there is
 * one. Never throws.
 */
export async function refreshSingleFlight(
  config: WebAuthConfig,
  incoming: Request,
  refreshToken: string,
): Promise<RefreshOutcome> {
  const key = await sha256Base64url(refreshToken);
  // No await between get and set: the check-and-insert is atomic on the event loop.
  const map = inflightMap();
  const existing = map.get(key);
  if (existing) return existing;
  const pending = callRefresh(config, incoming, refreshToken).finally(() => {
    if (map.get(key) === pending) map.delete(key);
  });
  map.set(key, pending);
  return pending;
}

/** For tests: number of refreshes currently in flight. */
export function inflightRefreshCount(): number {
  return inflightMap().size;
}

export const isTokenExpiredProblem = (code: string | undefined) => code === ErrorCode.TokenExpired;
