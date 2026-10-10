/**
 * Access-token revocation by session (design D11): `auth:revoked:sid:{sid}` in Redis, with a
 * TTL of the access-token lifetime + 60 s. Every method fails closed: Redis errors surface as
 * `RedisUnavailableError` (503 `service_unavailable`), never as "not revoked".
 */
export abstract class SessionRevocationStore {
  /** Revokes every access token of the session (logout, ban, reuse detection, ...). */
  abstract revoke(sessionId: string): Promise<void>;

  /** Same as `revoke` for many sessions in one round trip (logout-all, ban, password change). */
  abstract revokeMany(sessionIds: readonly string[]): Promise<void>;

  abstract isRevoked(sessionId: string): Promise<boolean>;
}
