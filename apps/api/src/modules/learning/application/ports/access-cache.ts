/**
 * Short-lived cache of "has an ACTIVE enrollment" for the heartbeat hot path (design §5
 * `RecordHeartbeat` step 2, Redis `lrn:acc:{u}:{c}`, 60 s). Fresh checks (bootstrap,
 * completions) write it, so a new enrollment is seen at once and a revocation within 60 s.
 * Never fails a request: an unreachable cache is a miss and the caller asks enrollment.
 */
export abstract class AccessCache {
  /** The cached answer, or null on a miss (or when the cache is unavailable). */
  abstract get(userId: string, courseId: string): Promise<boolean | null>;
  /** Best effort: errors are swallowed (logged). */
  abstract set(userId: string, courseId: string, hasAccess: boolean): Promise<void>;
}
