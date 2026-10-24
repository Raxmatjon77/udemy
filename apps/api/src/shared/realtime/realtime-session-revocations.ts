/**
 * Injection token of the session-revocation check used by the WS handshake (design D16:
 * `auth:revoked:sid:{sid}`, P1 D11). Bound in AppModule through `RealtimeModule.forRoot` to the
 * identity module's `SessionRevocationStore`, so `shared/realtime` imports no bounded context.
 */
export const REALTIME_SESSION_REVOCATIONS = Symbol.for('udemy.REALTIME_SESSION_REVOCATIONS');

export interface RealtimeSessionRevocations {
  /** Must fail closed: an error means "cannot tell", never "not revoked". */
  isRevoked(sessionId: string): Promise<boolean>;
}
