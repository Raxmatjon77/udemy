import { createHash } from 'node:crypto';

/** `identity.one_time_tokens.purpose` (CHECK one_time_tokens_purpose_ck). */
export const ONE_TIME_TOKEN_PURPOSES = ['EMAIL_VERIFICATION', 'PASSWORD_RESET'] as const;
export type OneTimeTokenPurpose = (typeof ONE_TIME_TOKEN_PURPOSES)[number];

/**
 * Lifetimes (24 h verification, 30 min reset, design §9) are applied by the worker when it
 * issues a token (`expires_at = requested_at + TTL`, D10/§14); the api only compares
 * `expires_at` with SQL `now()`.
 */

/**
 * `identity.one_time_tokens.token_hash`: SHA-256 of the raw token exactly as it appears in the
 * email link (base64url text, UTF-8). The api never sees or creates raw tokens except the one
 * a user presents; the worker stores the same hash when it issues the token (D10).
 */
export function hashOneTimeToken(rawToken: string): Buffer {
  return createHash('sha256').update(rawToken, 'utf8').digest();
}

/** The token row as the api's checks see it (locked, with the database clock). */
export interface OneTimeTokenState {
  readonly purpose: OneTimeTokenPurpose;
  /** Address the token was mailed to. */
  readonly email: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly invalidatedAt: Date | null;
}

/** Why a presented token was refused. Logged only; the client always gets `invalid_token`. */
export type OneTimeTokenRejection =
  'wrong_purpose' | 'consumed' | 'invalidated' | 'expired' | 'email_changed';

/**
 * The checks of design §5 VerifyEmail / ResetPassword, in order: purpose, consumed, invalidated,
 * expiry (against SQL `now()`), and that the token's email is still the account's email
 * (citext semantics: compared case-insensitively; both sides are normalised anyway).
 * Returns null when the token may be used.
 */
export function checkOneTimeToken(
  token: OneTimeTokenState,
  expected: { purpose: OneTimeTokenPurpose; currentEmail: string; now: Date },
): OneTimeTokenRejection | null {
  if (token.purpose !== expected.purpose) return 'wrong_purpose';
  if (token.consumedAt !== null) return 'consumed';
  if (token.invalidatedAt !== null) return 'invalidated';
  if (token.expiresAt.getTime() <= expected.now.getTime()) return 'expired';
  if (!sameEmail(token.email, expected.currentEmail)) return 'email_changed';
  return null;
}

/** citext equality (`identity.users.email` and `one_time_tokens.email` are citext). */
export function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
