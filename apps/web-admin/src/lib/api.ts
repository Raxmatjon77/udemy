import type { z } from 'zod';
import { createProxyFetch, type ProxyRequestInit } from '@udemy/web-auth/client';

import { ApiError } from './problem';

/**
 * Browser → BFF calls. The browser only ever talks to this app's own origin: `/api/proxy/*`
 * (forwarded to the API with the session) and `/api/auth/*` (login/logout). Tokens never reach
 * this code; they live in HttpOnly cookies.
 */

/** Default: a 401 the BFF could not fix sends the user to `/login?next=<here>`. */
const proxyFetch = createProxyFetch({ basePath: '/api/proxy', loginPath: '/login' });
/** For optional data on public pages (e.g. the header): a 401 just means "signed out". */
const quietProxyFetch = createProxyFetch({ basePath: '/api/proxy', onUnauthorized: () => {} });

export interface ApiRequestInit<T> extends ProxyRequestInit {
  /** Validate the JSON body against a contracts schema (recommended for reads). */
  schema?: z.ZodType<T>;
  /** Do not redirect to login on 401 (the caller handles a signed-out user). */
  quiet?: boolean;
}

async function readBody<T>(response: Response, schema?: z.ZodType<T>): Promise<T> {
  const text = response.status === 204 ? '' : await response.text();
  if (!text) return undefined as T;
  const json: unknown = JSON.parse(text);
  if (!schema) return json as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // The API and this app disagree on the contract: a generic error in the UI, the zod
    // details on `cause` for developers.
    throw new ApiError(502, null, null, { cause: parsed.error });
  }
  return parsed.data;
}

/**
 * `api('/me/profile')` → `GET /api/proxy/me/profile`, parsed JSON (or undefined for an empty
 * body). Throws `ApiError` on any non-2xx status.
 */
export async function api<T = unknown>(path: string, init: ApiRequestInit<T> = {}): Promise<T> {
  const { schema, quiet, ...rest } = init;
  const response = await (quiet ? quietProxyFetch : proxyFetch)(path, rest);
  if (!response.ok) throw await ApiError.fromResponse(response);
  return readBody(response, schema);
}

/** POST to one of this app's own `/api/auth/*` route handlers (login, logout, ...). */
export async function authPost<T = unknown>(
  route: 'login' | 'logout' | 'logout-all' | 'refresh',
  json?: unknown,
): Promise<T> {
  const response = await fetch(`/api/auth/${route}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  if (!response.ok) throw await ApiError.fromResponse(response);
  return readBody<T>(response);
}

/** Builds `?a=1&b=2`, skipping empty values. */
export function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}
