import 'server-only';
import { defineWebAuthConfig, type WebAuthConfig } from '@udemy/web-auth';

import { serverEnv } from '../env';

/** Where a signed-in user without the INSTRUCTOR role is sent (never role-gated itself). */
export const NOT_INSTRUCTOR_PATH = '/not-instructor';

let cached: WebAuthConfig | undefined;

/**
 * The validated @udemy/web-auth config of the instructor BFF, built on first use. Every page
 * except login requires a session with the INSTRUCTOR role.
 */
export function getWebAuthConfig(): WebAuthConfig {
  if (cached) return cached;
  const env = serverEnv();
  cached = defineWebAuthConfig({
    app: 'instructor',
    requiredRole: 'INSTRUCTOR',
    clientId: env.API_CLIENT_ID,
    clientSecret: env.API_CLIENT_SECRET,
    apiInternalUrl: env.API_INTERNAL_URL,
    appOrigin: env.APP_ORIGIN,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    jwksUrl: env.JWKS_URL,
    cookieSecure: env.COOKIE_SECURE,
    sameSite: 'lax',
    forbiddenRedirect: NOT_INSTRUCTOR_PATH,
  });
  return cached;
}
