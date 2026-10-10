import 'server-only';
import type { WebAuthConfigInput } from '@udemy/web-auth';

import { serverEnv } from '../env';

/** Where a signed-in user without the INSTRUCTOR role is sent (never role-gated itself). */
export const NOT_INSTRUCTOR_PATH = '/not-instructor';

/**
 * The @udemy/web-auth config of the instructor BFF, from the server env. Passed to the
 * factories as a thunk: they call and validate it on the first request (never at build time).
 * Every page except login requires a session with the INSTRUCTOR role.
 */
export function webAuthConfig(): WebAuthConfigInput {
  const env = serverEnv();
  return {
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
    mediaOrigin: env.MEDIA_PUBLIC_ORIGIN,
    sameSite: 'lax',
    forbiddenRedirect: NOT_INSTRUCTOR_PATH,
  };
}
