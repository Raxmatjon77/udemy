import 'server-only';
import type { ClientApp, Role } from '@udemy/contracts';
import { cookies } from 'next/headers';
import { lazyWithConfig, type WebAuthConfigSource } from './config';
import { cookieNames } from './cookies';
import { verifyAccessToken } from './jwt';

/**
 * Session read for server components and route handlers:
 *
 * ```ts
 * // src/lib/auth/session.ts (a config, or () => config: resolved on the first call)
 * export const getSession = createGetSession(webAuthConfig);
 * // in an RSC: const session = await getSession(); session?.roles
 * ```
 *
 * Reads the `at` cookie (already refreshed, or removed when the session ended, by proxy.ts for
 * this request) and verifies it via the JWKS. It never refreshes (RSCs cannot set cookies) and
 * never returns a token: only non-secret identity facts, safe to pass to client components as
 * props.
 *
 * Like proxy.ts it verifies LOCALLY: a session revoked on the server (logout-all, password
 * reset, ban) still reads as signed in until the first `/api/proxy/*` call is rejected with 401
 * `unauthorized`, which clears the cookies; the next render then reads null. The API is the
 * authority.
 *
 * `cookies()` is awaited before the config is resolved, so a prerender bails out (dynamic
 * rendering) before a thunk config, and the server secrets behind it, is ever touched.
 */

export interface Session {
  userId: string;
  roles: Role[];
  app: ClientApp;
}

export type GetSession = () => Promise<Session | null>;

export function createGetSession(source: WebAuthConfigSource): GetSession {
  const resolve = lazyWithConfig(source, (config) => ({
    config,
    access: cookieNames(config).access,
  }));
  return async function getSession() {
    const jar = await cookies();
    const { config, access } = resolve();
    const token = jar.get(access)?.value;
    if (!token) return null;
    const verified = await verifyAccessToken(config, token);
    if (verified.kind !== 'valid') return null;
    const { userId, roles, app } = verified.claims;
    return { userId, roles, app };
  };
}
