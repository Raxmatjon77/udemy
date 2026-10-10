import type { ClientApp, Permission, Role } from '@udemy/contracts';

/**
 * The authenticated end user of a request, built by JwtAuthGuard (T7) from a verified access
 * token. Permissions are derived from `roles` and `app` (design D6) and are never read from
 * the token itself.
 */
export interface Principal {
  readonly userId: string;
  /** `sid` claim: the refresh-token family / login session. */
  readonly sessionId: string;
  /** App the token was issued to; always equal to the calling client's app. */
  readonly app: ClientApp;
  /** Every role held, including the implicit STUDENT. */
  readonly roles: readonly Role[];
  /** Effective permissions in `app` (baseline + permissions of the roles allowed in that app). */
  readonly permissions: ReadonlySet<Permission>;
  /** `jti` claim of the access token. */
  readonly tokenId: string;
}

/**
 * The calling BFF, authenticated by ClientAuthGuard (T7) with X-Client-Id + secret.
 * `ip`/`userAgent` are the end user's as reported by the BFF (X-Client-IP /
 * X-Client-User-Agent), trusted only because the client is authenticated (design §9).
 */
export interface ClientContext {
  /** `student-bff`, `instructor-bff` or `admin-bff`. */
  readonly clientId: string;
  readonly app: ClientApp;
  readonly ip: string;
  readonly userAgent: string;
}
