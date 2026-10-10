import type { DB, Transaction } from '@udemy/db';
import type { OneTimeTokenPurpose } from './one-time-token';

/** The user row under the per-user mutex, with the database clock. */
export interface LockedTokenOwner {
  readonly email: string;
  readonly now: Date;
}

export interface NewOneTimeToken {
  readonly userId: string;
  readonly purpose: OneTimeTokenPurpose;
  readonly tokenHash: Buffer;
  readonly email: string;
  readonly sourceEventId: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

export interface StoredOneTimeToken {
  readonly tokenHash: Buffer;
  /** Neither consumed nor invalidated. */
  readonly live: boolean;
}

/**
 * The SQL of IssueOneTimeToken (`identity.one_time_tokens`, schema doc §1/§6/§14). Every method
 * runs in the handler's transaction, which already holds the processed_events claim.
 */
export abstract class OneTimeTokenStore {
  /** `SELECT email, now() FROM identity.users WHERE id = $1 FOR NO KEY UPDATE`. */
  abstract lockOwner(trx: Transaction<DB>, userId: string): Promise<LockedTokenOwner | null>;

  /** A token of this purpose with a later `requested_at` exists (out-of-order delivery). */
  abstract hasNewerRequest(
    trx: Transaction<DB>,
    userId: string,
    purpose: OneTimeTokenPurpose,
    requestedAt: Date,
  ): Promise<boolean>;

  /**
   * `invalidated_at = now()` on the live tokens of that purpose, EXCEPT the one issued for
   * `sourceEventId` (§14: on a redelivery the token must not invalidate itself).
   */
  abstract invalidateOthers(
    trx: Transaction<DB>,
    userId: string,
    purpose: OneTimeTokenPurpose,
    sourceEventId: string,
  ): Promise<number>;

  /** `INSERT ... ON CONFLICT (source_event_id) DO NOTHING`. */
  abstract insertIfAbsent(trx: Transaction<DB>, token: NewOneTimeToken): Promise<void>;

  abstract findBySourceEvent(
    trx: Transaction<DB>,
    sourceEventId: string,
  ): Promise<StoredOneTimeToken | null>;
}
