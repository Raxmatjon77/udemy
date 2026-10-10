import { createHash, createHmac } from 'node:crypto';

/** `identity.one_time_tokens.purpose` (CHECK one_time_tokens_purpose_ck). */
export type OneTimeTokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

/** Design §9: verification links live 24 h, reset links 30 min (from `requested_at`). */
export const ONE_TIME_TOKEN_TTL_MS: Readonly<Record<OneTimeTokenPurpose, number>> = Object.freeze({
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 30 * 60 * 1000,
});

/**
 * D10: `raw = base64url(HMAC-SHA256(EMAIL_TOKEN_SECRET, eventId ‖ purpose))`. Deterministic, so
 * a redelivered event yields the same token and the re-sent mail carries a link that still
 * works. 32 bytes -> 43 base64url characters (URL-safe, no padding).
 */
export function deriveOneTimeToken(
  secret: string,
  eventId: string,
  purpose: OneTimeTokenPurpose,
): string {
  return createHmac('sha256', secret).update(eventId).update(purpose).digest('base64url');
}

/**
 * `token_hash`: SHA-256 of the raw token text (UTF-8). Must match the api's lookup
 * (`hashOneTimeToken` in apps/api identity/domain/one-time-token.ts); the cross-process
 * integration test and the e2e run prove the two agree.
 */
export function hashOneTimeToken(rawToken: string): Buffer {
  return createHash('sha256').update(rawToken, 'utf8').digest();
}

/** citext equality (`identity.users.email` and `one_time_tokens.email` are citext). */
export function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
