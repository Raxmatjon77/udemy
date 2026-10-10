/**
 * HMAC-SHA256(LOGIN_EMAIL_HMAC_KEY, normalised email): the login rate-limit key component and
 * `security_events.email_hash`. The raw email never reaches Redis or the security log.
 */
export abstract class LoginEmailHasher {
  /** 32 bytes. */
  abstract hash(normalizedEmail: string): Buffer;
}
