import 'server-only';
import type { ClientApp, Role } from '@udemy/contracts';
import { cookies } from 'next/headers';
import { defineWebAuthConfig, type WebAuthConfig, type WebAuthConfigInput } from './config';
import { cookieNames } from './cookies';
import { verifyAccessToken } from './jwt';

/**
 * Session read for server components and route handlers:
 *
 * ```ts
 * // src/lib/auth.ts
 * export const getSession = createGetSession(webAuthConfig);
 * // in an RSC: const session = await getSession(); session?.roles
 * ```
 *
 * Reads the `at` cookie (already refreshed by proxy.ts for this request) and verifies it via
 * the JWKS. It never refreshes (RSCs cannot set cookies) and never returns a token: only
 * non-secret identity facts, safe to pass to client components as props.
 */

export interface Session {
  userId: string;
  roles: Role[];
  app: ClientApp;
}

export type GetSession = () => Promise<Session | null>;

export function createGetSession(input: WebAuthConfigInput | WebAuthConfig): GetSession {
  const config = defineWebAuthConfig(input);
  const { access } = cookieNames(config);
  return async function getSession() {
    const token = (await cookies()).get(access)?.value;
    if (!token) return null;
    const verified = await verifyAccessToken(config, token);
    if (verified.kind !== 'valid') return null;
    const { userId, roles, app } = verified.claims;
    return { userId, roles, app };
  };
}
