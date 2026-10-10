import type { ClientApp } from '@udemy/contracts';

/** Refresh-token lifetimes of one app (design §9 "Token lifetimes"). */
export interface SessionLifetime {
  /** A refresh token expires this long after it was issued (sliding, per rotation). */
  readonly idleTtlSeconds: number;
  /** The session (token family) ends this long after login, whatever the activity. */
  readonly absoluteTtlSeconds: number;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** student 14 d / 60 d, instructor 7 d / 30 d, admin 1 h / 12 h. */
export const SESSION_LIFETIMES: Readonly<Record<ClientApp, SessionLifetime>> = Object.freeze({
  student: { idleTtlSeconds: 14 * DAY, absoluteTtlSeconds: 60 * DAY },
  instructor: { idleTtlSeconds: 7 * DAY, absoluteTtlSeconds: 30 * DAY },
  admin: { idleTtlSeconds: 1 * HOUR, absoluteTtlSeconds: 12 * HOUR },
});

export function sessionLifetime(app: ClientApp): SessionLifetime {
  return SESSION_LIFETIMES[app];
}

/**
 * A refresh token presented again within this window after its rotation, while its child is
 * still current and from the same app, is a parallel refresh (two tabs, two BFF instances),
 * not a theft: it gets an access token only (design §4 state machine, §9).
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

/** `identity.sessions.revoke_reason` (CHECK sessions_revoke_reason_ck). */
export const SESSION_REVOKE_REASONS = [
  'LOGOUT',
  'LOGOUT_ALL',
  'USER_REVOKED',
  'REUSE_DETECTED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'BANNED',
  'ROLE_LOST',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/**
 * Why a refresh was refused. Never sent to the client (always `invalid_refresh_token`), only
 * logged and stored in `security_events.metadata.cause`.
 */
export type RefreshRejectionCause =
  | 'unknown_token'
  | 'session_revoked'
  | 'session_expired'
  | 'wrong_app'
  | 'token_expired'
  | 'reuse_detected'
  | 'account_missing'
  | 'banned'
  | 'role_lost';

/**
 * State of a presented refresh token at the time of the refresh (design §4 refresh-token
 * state machine). Pure: all timestamps come from the database clock (`now`).
 */
export interface PresentedToken {
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
}

export interface TokenSession {
  readonly clientApp: ClientApp;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface TokenChild {
  /** null = the child is still the current token of the family. */
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
}

export type RefreshDecision =
  | { readonly kind: 'rotate' }
  | { readonly kind: 'grace' }
  | { readonly kind: 'reuse' }
  | { readonly kind: 'reject'; readonly cause: RefreshRejectionCause };

/**
 * Steps 2–4 of the refresh algorithm (design §4), in that order:
 *
 * 2. revoked or expired session, or a session of another app -> reject
 * 3. consumed token -> grace (rotated < 10 s ago, child still current and unexpired, same app)
 *    or reuse (anything else: the family must be revoked)
 * 4. expired token -> reject
 *
 * then `rotate`. Steps 5–7 (ban/role checks, rotation, minting) need I/O and live in the use case.
 */
export function decideRefresh(input: {
  token: PresentedToken;
  session: TokenSession;
  child: TokenChild | null;
  clientApp: ClientApp;
  now: Date;
}): RefreshDecision {
  const { token, session, child, clientApp, now } = input;
  const nowMs = now.getTime();

  if (session.revokedAt !== null) return { kind: 'reject', cause: 'session_revoked' };
  if (session.absoluteExpiresAt.getTime() <= nowMs) {
    return { kind: 'reject', cause: 'session_expired' };
  }
  if (session.clientApp !== clientApp) return { kind: 'reject', cause: 'wrong_app' };

  if (token.consumedAt !== null) {
    const withinGrace = nowMs - token.consumedAt.getTime() < REFRESH_REUSE_GRACE_MS;
    const childIsCurrent =
      child !== null && child.consumedAt === null && child.expiresAt.getTime() > nowMs;
    return withinGrace && childIsCurrent ? { kind: 'grace' } : { kind: 'reuse' };
  }

  if (token.expiresAt.getTime() <= nowMs) return { kind: 'reject', cause: 'token_expired' };
  return { kind: 'rotate' };
}
