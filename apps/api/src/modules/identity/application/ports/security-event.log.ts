import type { ClientApp } from '@udemy/contracts';
import type { Executor } from '@udemy/db';

/** `identity.security_events.type` (CHECK security_events_type_ck). */
export type SecurityEventType =
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'LOGIN_THROTTLED'
  | 'REFRESH_REUSE_DETECTED'
  | 'REFRESH_REJECTED'
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'SESSION_REVOKED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_CHANGED'
  | 'EMAIL_VERIFIED'
  | 'USER_BANNED'
  | 'USER_UNBANNED';

/** Small, flat, camelCase metadata (<= 4 KiB, CamelCasePlugin camel-cases jsonb keys on read). */
export type SecurityEventMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface SecurityEvent {
  readonly type: SecurityEventType;
  readonly userId?: string | null;
  readonly sessionId?: string | null;
  readonly clientApp?: ClientApp | null;
  /** Any string; values that are not a literal IP are stored as NULL. */
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** HMAC of the attempted email, for failures without a known account. Never the raw email. */
  readonly emailHash?: Buffer | null;
  readonly metadata?: SecurityEventMetadata;
}

/** Append-only authentication telemetry (`identity.security_events`, never on Kafka). */
export abstract class SecurityEventLog {
  /** Writes in `ex` (a transaction, so it commits with the state change) or the root db. */
  abstract record(event: SecurityEvent, ex?: Executor): Promise<void>;
}
