import type { ClientApp } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { SessionRevokeReason } from '../../domain/session';

export interface NewSession {
  readonly userId: string;
  readonly app: ClientApp;
  /** A literal IP address (inet). */
  readonly ip: string;
  /** Truncated to 512 characters; null when empty. */
  readonly userAgent: string | null;
  readonly absoluteTtlSeconds: number;
}

export interface CreatedSession {
  readonly id: string;
  readonly absoluteExpiresAt: Date;
}

export interface NewRefreshToken {
  readonly sessionId: string;
  readonly tokenHash: Buffer;
  /** The rotated token; null for the first token of a session. */
  readonly parentId: string | null;
  /** `expires_at = least(now() + idleTtl, session.absolute_expires_at)`. */
  readonly idleTtlSeconds: number;
}

/** A refresh token row locked FOR UPDATE, plus the database clock. */
export interface LockedRefreshToken {
  readonly id: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  /** SQL now() of this transaction: every refresh decision uses the database clock. */
  readonly now: Date;
}

export interface LockedSession {
  readonly id: string;
  readonly userId: string;
  readonly clientApp: ClientApp;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface ChildToken {
  readonly id: string;
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
}

/** A session found through one of its refresh tokens (logout). */
export interface TokenOwner {
  readonly sessionId: string;
  readonly userId: string;
  readonly clientApp: ClientApp;
}

/** Row of the sessions list (schema doc §6 query). */
export interface ActiveSessionRow {
  readonly id: string;
  readonly app: ClientApp;
  readonly userAgent: string | null;
  readonly lastIp: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
}

/**
 * `identity.sessions` + `identity.refresh_tokens`. Lock order is always token row, then
 * session row (schema doc §6); bulk revocations lock sessions only, so no deadlock cycle.
 */
export abstract class SessionRepository {
  abstract createSession(trx: Transaction<DB>, session: NewSession): Promise<CreatedSession>;

  /** @returns the new token's id and `expires_at` */
  abstract insertRefreshToken(
    trx: Transaction<DB>,
    token: NewRefreshToken,
  ): Promise<{ id: string; expiresAt: Date }>;

  /** `SELECT ... WHERE token_hash = $1 FOR UPDATE` (+ `now()`). */
  abstract lockTokenByHash(
    trx: Transaction<DB>,
    tokenHash: Buffer,
  ): Promise<LockedRefreshToken | null>;

  /** `SELECT ... FROM identity.sessions WHERE id = $1 FOR UPDATE`. */
  abstract lockSession(trx: Transaction<DB>, sessionId: string): Promise<LockedSession | null>;

  /** The token that replaced `tokenId` (unique `parent_id`), if any. */
  abstract findChild(trx: Transaction<DB>, tokenId: string): Promise<ChildToken | null>;

  /** `consumed_at = now()`. */
  abstract consumeToken(trx: Transaction<DB>, tokenId: string): Promise<void>;

  /** `last_used_at = now(), last_ip = $ip`. */
  abstract touchSession(trx: Transaction<DB>, sessionId: string, ip: string): Promise<void>;

  /** Revokes one session if still active; false when it was already revoked. */
  abstract revokeSession(
    trx: Transaction<DB>,
    sessionId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean>;

  /** Revokes the user's session `sessionId` if it is theirs and active; false otherwise. */
  abstract revokeOwnSession(
    trx: Transaction<DB>,
    userId: string,
    sessionId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean>;

  /** Revokes every active session of the user; returns their ids. */
  abstract revokeAllForUser(
    trx: Transaction<DB>,
    userId: string,
    reason: SessionRevokeReason,
  ): Promise<string[]>;

  /** The session a refresh token (current or consumed) belongs to; no lock. */
  abstract findTokenOwner(ex: Executor, tokenHash: Buffer): Promise<TokenOwner | null>;

  /** Not revoked, not absolutely expired, current token not expired. */
  abstract listActive(userId: string, ex?: Executor): Promise<ActiveSessionRow[]>;

  abstract countActive(userId: string, ex?: Executor): Promise<number>;
}
