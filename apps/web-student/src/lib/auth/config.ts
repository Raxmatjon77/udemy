import 'server-only';
import type { WebAuthConfigInput } from '@udemy/web-auth';

import { serverEnv } from '../env';

/**
 * Pages anyone may see. Login, signup, forgot-password, /verify-email and /reset-password are
 * always public in @udemy/web-auth and need not be listed. Everything else requires a session.
 * An entry ending in `/*` covers the base path and everything below it.
 *
 * - `/courses`, `/categories/*`, `/course/*`: the public catalog (design §10).
 * - `/media/*`: the signed-redirect image routes (thumbnails). Route handlers outside `/api/`
 *   go through proxy.ts too, so without this an anonymous visitor's `<img>` would be
 *   redirected to the login page (design §14).
 * - `/cart`: the guest cart (Phase 4 D4); checking out sends a visitor to the login page.
 *   `/checkout/*`, `/my-learning` and `/account/*` are NOT listed: they need a session.
 */
export const PUBLIC_PATHS = [
  '/',
  '/verify-email/pending',
  '/courses',
  '/categories/*',
  '/course/*',
  '/media/*',
  '/cart',
];

/**
 * The @udemy/web-auth config of the student BFF, from the server env. Passed to the factories
 * as a thunk: they call and validate it on the first request (never at build time). Every
 * signed-in user holds STUDENT, so the default `forbiddenRedirect` is never reached in practice.
 */
export function webAuthConfig(): WebAuthConfigInput {
  const env = serverEnv();
  return {
    app: 'student',
    requiredRole: 'STUDENT',
    clientId: env.API_CLIENT_ID,
    clientSecret: env.API_CLIENT_SECRET,
    apiInternalUrl: env.API_INTERNAL_URL,
    appOrigin: env.APP_ORIGIN,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    jwksUrl: env.JWKS_URL,
    cookieSecure: env.COOKIE_SECURE,
    mediaOrigin: env.MEDIA_PUBLIC_ORIGIN,
    realtimeOrigin: env.REALTIME_PUBLIC_URL,
    sameSite: 'lax',
    publicPaths: PUBLIC_PATHS,
  };
}
