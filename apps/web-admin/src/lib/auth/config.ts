import 'server-only';
import { defineWebAuthConfig, type WebAuthConfig } from '@udemy/web-auth';

import { serverEnv } from '../env';

let cached: WebAuthConfig | undefined;

/**
 * The validated @udemy/web-auth config of the admin BFF, built on first use. Every page except
 * login requires a session with the ADMIN role; cookies are SameSite=Strict (design §9).
 */
export function getWebAuthConfig(): WebAuthConfig {
  if (cached) return cached;
  const env = serverEnv();
  cached = defineWebAuthConfig({
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
    sameSite: 'strict',
    homePath: '/instructor-applications',
    forbiddenRedirect: '/login?error=forbidden',
  });
  return cached;
}
