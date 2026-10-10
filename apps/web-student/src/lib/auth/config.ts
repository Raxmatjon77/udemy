import 'server-only';
import { defineWebAuthConfig, type WebAuthConfig } from '@udemy/web-auth';

import { serverEnv } from '../env';

/**
 * Pages anyone may see. Login, signup, forgot-password, /verify-email and /reset-password are
 * always public in @udemy/web-auth and need not be listed. Everything else requires a session.
 */
export const PUBLIC_PATHS = ['/', '/verify-email/pending'];

let cached: WebAuthConfig | undefined;

/** The validated @udemy/web-auth config of the student BFF, built on first use. */
export function getWebAuthConfig(): WebAuthConfig {
  if (cached) return cached;
  const env = serverEnv();
  cached = defineWebAuthConfig({
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
    sameSite: 'lax',
    publicPaths: PUBLIC_PATHS,
    // Every signed-in user holds STUDENT, so this is only reached by a malformed token.
    forbiddenRedirect: '/login',
  });
  return cached;
}
