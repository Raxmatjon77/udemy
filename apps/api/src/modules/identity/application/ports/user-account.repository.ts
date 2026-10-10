import type { DB, Executor, Transaction } from '@udemy/db';

/** What login/refresh/signup need to know about an account. */
export interface AccountRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  /** An unlifted ban exists. */
  readonly banned: boolean;
}

export interface NewAccount {
  /** Normalised by the Email VO. */
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  /** true only for CLI provisioning; signup always starts unverified. */
  readonly emailVerified: boolean;
}

/** The account row under the per-user mutex, read together with the database clock. */
export interface LockedAccount {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: Date | null;
  /** SQL now() of this transaction. */
  readonly now: Date;
}

export interface InsertedAccount {
  readonly id: string;
  /** SQL now() of the insert. */
  readonly createdAt: Date;
}

/**
 * `identity.users` (implemented with Kysely). Read methods use the root database when no
 * executor is given. All state timestamps are SQL `now()` (schema doc §6).
 */
export abstract class UserAccountRepository {
  /** Lookup by normalised email (citext: case-insensitive). */
  abstract findByEmail(email: string, ex?: Executor): Promise<AccountRecord | null>;

  abstract findById(userId: string, ex?: Executor): Promise<AccountRecord | null>;

  /**
   * `INSERT ... ON CONFLICT (email) DO NOTHING RETURNING`: null when the email is taken
   * (`users_email_uq`). Never aborts the transaction on a duplicate.
   */
  abstract insertIfAbsent(
    trx: Transaction<DB>,
    account: NewAccount,
  ): Promise<InsertedAccount | null>;

  /** Login rehash: replaces the hash only (not `password_changed_at`: same password). */
  abstract replacePasswordHash(trx: Transaction<DB>, userId: string, hash: string): Promise<void>;

  /**
   * Sets the display name. `null` = unknown user; `changed: false` = it already had that name
   * (no row update, no event).
   */
  abstract updateDisplayName(
    trx: Transaction<DB>,
    userId: string,
    displayName: string,
  ): Promise<{ changed: boolean; changedAt: Date } | null>;

  /**
   * Per-user mutex (schema doc §6): `SELECT ... FOR NO KEY UPDATE` on the user row. Taken by
   * ban, unban, grant/revoke role, password change/reset and IssueOneTimeToken. false = no user.
   */
  abstract lockUser(trx: Transaction<DB>, userId: string): Promise<boolean>;

  /**
   * `SELECT ... FOR SHARE` on the user row: taken by login before it creates a session. It
   * conflicts with the writers' `FOR NO KEY UPDATE` (ban, role revoke), so a session is never
   * created concurrently with a ban that would miss it. Concurrent logins do not block each
   * other. false = no user.
   */
  abstract lockUserShared(trx: Transaction<DB>, userId: string): Promise<boolean>;

  /**
   * `lockUser` that also returns the fresh account state and `now()`: the per-user mutex of
   * the email/password flows (verify, reset, change, request reset/verification). null = no user.
   */
  abstract lockAccount(trx: Transaction<DB>, userId: string): Promise<LockedAccount | null>;

  /**
   * `email_verified_at = now()` if still unverified. Returns the timestamp it set, or null when
   * the address was already verified (no update, no event).
   */
  abstract markEmailVerified(trx: Transaction<DB>, userId: string): Promise<Date | null>;

  /** New password: sets the hash and `password_changed_at = now()`; returns that timestamp. */
  abstract changePassword(trx: Transaction<DB>, userId: string, hash: string): Promise<Date>;
}
