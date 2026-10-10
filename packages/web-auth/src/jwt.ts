import 'server-only';
import { ClientAppSchema, RoleSchema, type ClientApp, type Role } from '@udemy/contracts';
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { WebAuthConfig } from './config';

/**
 * Access-token verification for the BFF (proxy.ts and server components).
 *
 * This is a UX gate only; the API re-verifies every token with its local keys and checks the
 * Redis sid key (design §9). The BFF uses the API's JWKS (jose `createRemoteJWKSet`), cached
 * per JWKS URL for the life of the process; jose re-fetches on an unknown `kid` (30 s
 * cooldown) and after `cacheMaxAge`, which matches the API's `Cache-Control: max-age=300`.
 */

/** Refresh when the access token has less than this left (design §10). */
export const REFRESH_THRESHOLD_S = 30;

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  app: ClientAppSchema,
  roles: z.array(RoleSchema),
  exp: z.number(),
});

export interface AccessClaims {
  userId: string;
  sessionId: string;
  app: ClientApp;
  roles: Role[];
  /** Expiry, seconds since epoch. */
  exp: number;
}

export type VerifyResult =
  | { kind: 'valid'; claims: AccessClaims }
  | { kind: 'expired' }
  /** Bad signature, unknown kid, wrong iss/aud/alg, malformed claims. */
  | { kind: 'invalid' }
  /** Verified, but issued to a different client app (D6 app confinement). */
  | { kind: 'wrong-app' }
  /** The JWKS could not be fetched; the token's validity is unknown. */
  | { kind: 'unavailable' };

const JWKS_KEY = Symbol.for('@udemy/web-auth/jwks');
type JwksCache = Map<string, JWTVerifyGetKey>;

function jwksFor(url: string): JWTVerifyGetKey {
  const holder = globalThis as unknown as Record<symbol, JwksCache | undefined>;
  const cache = (holder[JWKS_KEY] ??= new Map());
  let jwks = cache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 5 * 60_000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
    cache.set(url, jwks);
  }
  return jwks;
}

/** For tests: forget cached JWKS instances. */
export function resetJwksCache(): void {
  const holder = globalThis as unknown as Record<symbol, JwksCache | undefined>;
  holder[JWKS_KEY]?.clear();
}

export async function verifyAccessToken(
  config: WebAuthConfig,
  token: string,
): Promise<VerifyResult> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(config.jwksUrl), {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      algorithms: ['EdDSA'],
      requiredClaims: ['sub', 'exp', 'iat'],
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { kind: 'expired' };
    if (
      error instanceof errors.JWKSTimeout ||
      (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC') ||
      (error instanceof Error && !(error instanceof errors.JOSEError))
    ) {
      // Network failure fetching the JWKS (fetch TypeError, timeout, non-200 JWKS response).
      return { kind: 'unavailable' };
    }
    return { kind: 'invalid' };
  }
  const parsed = ClaimsSchema.safeParse(payload);
  if (!parsed.success) return { kind: 'invalid' };
  if (parsed.data.app !== config.app) return { kind: 'wrong-app' };
  const { sub, sid, app, roles, exp } = parsed.data;
  return { kind: 'valid', claims: { userId: sub, sessionId: sid, app, roles, exp } };
}

/** Seconds left on a token according to its (unverified) `exp`; `0` when unreadable. */
export function secondsLeft(token: string, now: number = Date.now()): number {
  try {
    const { exp } = decodeJwt(token);
    return typeof exp === 'number' ? exp - Math.floor(now / 1000) : 0;
  } catch {
    return 0;
  }
}

export function isExpiring(exp: number, now: number = Date.now()): boolean {
  return exp - Math.floor(now / 1000) < REFRESH_THRESHOLD_S;
}
