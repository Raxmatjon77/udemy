import type { ClientApp, Role } from '@udemy/contracts';

/** Lifetime of an access token (design §9: 15 min for every app). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Allowed clock skew when verifying `exp`/`iat` (design §9). */
export const ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/**
 * TTL of `auth:revoked:sid:{sid}` (design §6): an access token of that session can be at most
 * this old (TTL plus skew), so the key may expire afterwards.
 */
export const SESSION_REVOCATION_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS + 60;

/** The JWS `alg` of every access token (design D1). */
export const ACCESS_TOKEN_ALGORITHM = 'EdDSA';

/**
 * The verified claims of an access token, exactly as listed in design §9. No email,
 * permissions or verification state: those are stale-prone and read fresh by use cases.
 */
export interface AccessTokenClaims {
  /** `API_PUBLIC_URL`. */
  readonly iss: string;
  /** `JWT_AUDIENCE` (`udemy-api`). */
  readonly aud: string;
  /** User id. */
  readonly sub: string;
  /** Session (refresh-token family) id. */
  readonly sid: string;
  /** App (BFF) the token was issued to. */
  readonly app: ClientApp;
  /** Every role held, including STUDENT. */
  readonly roles: readonly Role[];
  /** Seconds since the epoch. */
  readonly iat: number;
  /** Seconds since the epoch; `iat + ACCESS_TOKEN_TTL_SECONDS`. */
  readonly exp: number;
  /** uuidv7 token id. */
  readonly jti: string;
}
