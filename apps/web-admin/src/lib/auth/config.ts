import 'server-only';
import type { WebAuthConfigInput } from '@udemy/web-auth';

import { serverEnv } from '../env';

/**
 * The @udemy/web-auth config of the admin BFF, from the server env. Passed to the factories as a
 * thunk: they call and validate it on the first request (never at build time). Every page
 * except login requires a session with the ADMIN role; cookies are SameSite=Strict (design §9).
 */
export function webAuthConfig(): WebAuthConfigInput {
  const env = serverEnv();
  return {
    app: 'admin',
    requiredRole: 'ADMIN',
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
    sameSite: 'strict',
    homePath: '/instructor-applications',
    forbiddenRedirect: '/login?error=forbidden',
  };
}
