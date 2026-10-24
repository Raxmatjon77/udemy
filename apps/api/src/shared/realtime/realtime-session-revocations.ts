/**
 * Injection token of the session-revocation check used by the WS handshake (design D16:
 * `auth:revoked:sid:{sid}`, P1 D11) and by the 60 s sweep of live sockets. Bound in AppModule
 * through `RealtimeModule.forRoot` to the identity module's `SessionRevocationStore`, so
 * `shared/realtime` imports no bounded context.
 */
export const REALTIME_SESSION_REVOCATIONS = Symbol.for('udemy.REALTIME_SESSION_REVOCATIONS');

export interface RealtimeSessionRevocations {
  /** Must fail closed: an error means "cannot tell", never "not revoked". */
  isRevoked(sessionId: string): Promise<boolean>;

  /**
   * The revoked sessions among `sessionIds`, in as few round trips as possible (MGET). Throws
   * when it cannot tell; never answers "none revoked" on an error.
   */
  revokedAmong(sessionIds: readonly string[]): Promise<ReadonlySet<string>>;
}
