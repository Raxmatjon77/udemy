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

  /**
   * The revoked sessions among `sessionIds` (the realtime layer's 60 s sweep of local sockets,
   * Phase 5 design D16). The default asks `isRevoked` per session; the Redis store overrides it
   * with batched MGETs. Fails closed like `isRevoked` (throws, never "none revoked").
   */
  async revokedAmong(sessionIds: readonly string[]): Promise<ReadonlySet<string>> {
    const unique = [...new Set(sessionIds)];
    const flags = await Promise.all(unique.map((sessionId) => this.isRevoked(sessionId)));
    return new Set(unique.filter((_, index) => flags[index] === true));
  }
}
