import { ErrorCode } from '@udemy/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@udemy/nest-common/errors';
import { RateLimitedError } from '../../../shared/errors/rate-limited.error';

/** Why a password was refused. Logged/tested only; clients get one generic message. */
export type WeakPasswordReason = 'too_short' | 'too_long' | 'matches_email' | 'common';

/** 422 `weak_password`: the password breaks the policy of design §4 (NIST 800-63B). */
export class WeakPassword extends ValidationError {
  constructor(
    readonly reason: WeakPasswordReason,
    field = 'password',
  ) {
    const message = WEAK_PASSWORD_MESSAGES[reason];
    super(message, { code: ErrorCode.WeakPassword, issues: [{ path: field, message }] });
  }
}

const WEAK_PASSWORD_MESSAGES: Record<WeakPasswordReason, string> = {
  too_short: 'The password must be at least 10 characters long.',
  too_long: 'The password must be at most 128 characters long.',
  matches_email: 'The password must not be your email address.',
  common: 'This password is too common. Choose a less predictable one.',
};

/** 422 `validation_failed`: the value cannot be an email address (domain rules of §4). */
export class InvalidEmail extends ValidationError {
  constructor(field = 'email') {
    const message = 'Invalid email address.';
    super(message, { code: ErrorCode.ValidationFailed, issues: [{ path: field, message }] });
  }
}

/** 422 `validation_failed`: the display name breaks the rules of §4. */
export class InvalidDisplayName extends ValidationError {
  constructor(field = 'displayName') {
    const message = 'The display name must be 1–60 characters without control characters.';
    super(message, { code: ErrorCode.ValidationFailed, issues: [{ path: field, message }] });
  }
}

/**
 * 401 `unauthorized`: missing, malformed, forged, revoked or foreign-app access token, or bad
 * client credentials. One code and one message for every cause, so callers cannot probe which
 * check failed (the cause is only logged).
 */
export class Unauthenticated extends UnauthorizedError {
  constructor(options: { cause?: unknown } = {}) {
    super('Authentication required.', { code: ErrorCode.Unauthorized, cause: options.cause });
  }
}

/**
 * 401 `token_expired`: a well-formed access token, correctly signed for this issuer and
 * audience, whose `exp` has passed (beyond the clock tolerance). The BFF refreshes once and
 * retries on exactly this code (design §10), so it must never be used for anything else.
 */
export class AccessTokenExpired extends UnauthorizedError {
  constructor() {
    super('The access token has expired.', { code: ErrorCode.TokenExpired });
  }
}

/** 403 `client_not_allowed`: an authenticated BFF calling a route restricted to other apps. */
export class ClientNotAllowed extends ForbiddenError {
  constructor() {
    super('This client may not call this endpoint.', { code: ErrorCode.ClientNotAllowed });
  }
}

/* ----------------------------------------------------------------------------------------
 * Login, refresh, sessions (T8). Messages are generic on purpose: they are identical for
 * existing and unknown accounts (design §9 "Enumeration and timing").
 * -------------------------------------------------------------------------------------- */

/** 401 `invalid_credentials`: unknown email or wrong password (indistinguishable). */
export class InvalidCredentials extends UnauthorizedError {
  constructor() {
    super('The email or password is incorrect.', { code: ErrorCode.InvalidCredentials });
  }
}

/** 429 `too_many_attempts` + Retry-After: a login limiter of design §6 is exhausted. */
export class TooManyAttempts extends RateLimitedError {
  constructor(retryAfterMs: number) {
    super('Too many attempts. Please wait and try again.', {
      code: ErrorCode.TooManyAttempts,
      retryAfterMs,
    });
  }
}

/** 429 `rate_limited` + Retry-After: too many signups from this IP (`rl:signup:ip`). */
export class SignupRateLimited extends RateLimitedError {
  constructor(retryAfterMs: number) {
    super('Too many requests. Please wait and try again.', {
      code: ErrorCode.RateLimited,
      retryAfterMs,
    });
  }
}

/** 403 `account_banned`: only ever returned after a correct password. */
export class AccountBanned extends ForbiddenError {
  constructor() {
    super('This account has been suspended.', { code: ErrorCode.AccountBanned });
  }
}

/** 403 `app_access_denied`: correct password, but no role allowed in this app (D6). */
export class AppAccessDenied extends ForbiddenError {
  constructor() {
    super('This account cannot sign in to this application.', {
      code: ErrorCode.AppAccessDenied,
    });
  }
}

/**
 * 401 `invalid_refresh_token`: ONE code for unknown, expired, revoked, reused, banned,
 * role-lost and wrong-app tokens. The exact cause is only logged and written to
 * `identity.security_events` (REFRESH_REJECTED / REFRESH_REUSE_DETECTED).
 */
export class InvalidRefreshToken extends UnauthorizedError {
  constructor() {
    super('The session is no longer valid. Please sign in again.', {
      code: ErrorCode.InvalidRefreshToken,
    });
  }
}

/** 404 `session_not_found`: also for sessions of other users (no ID probing). */
export class SessionNotFound extends NotFoundError {
  constructor() {
    super('The session does not exist.', { code: ErrorCode.SessionNotFound });
  }
}

/* ----------------------------------------------------------------------------------------
 * Accounts and bans (facade)
 * -------------------------------------------------------------------------------------- */

/** 404 `user_not_found`. */
export class AccountNotFound extends NotFoundError {
  constructor(options: { cause?: unknown } = {}) {
    super('The user does not exist.', { code: ErrorCode.UserNotFound, cause: options.cause });
  }
}

/** 409 `already_banned`: the user already has an active ban (one per user). */
export class AlreadyBanned extends ConflictError {
  constructor(options: { cause?: unknown } = {}) {
    super('The user is already banned.', { code: ErrorCode.AlreadyBanned, cause: options.cause });
  }
}

/** 409 `not_banned`: unban of a user without an active ban. */
export class NotBanned extends ConflictError {
  constructor() {
    super('The user is not banned.', { code: ErrorCode.NotBanned });
  }
}

/** 409 `cannot_ban_self`. */
export class CannotBanSelf extends ConflictError {
  constructor(options: { cause?: unknown } = {}) {
    super('You cannot ban yourself.', { code: ErrorCode.CannotBanSelf, cause: options.cause });
  }
}

/** 422 `validation_failed` on `reason` (ban 10–1000, lift 1–1000 characters). */
export class InvalidBanReason extends ValidationError {
  constructor(field = 'reason') {
    const message = 'The reason must be between 10 and 1000 characters.';
    super(message, { code: ErrorCode.ValidationFailed, issues: [{ path: field, message }] });
  }
}

/** 422 `validation_failed`: a malformed keyset cursor or search parameter. */
export class InvalidSearchParameter extends ValidationError {
  constructor(field: string, message: string) {
    super(message, { code: ErrorCode.ValidationFailed, issues: [{ path: field, message }] });
  }
}

/**
 * The email is taken (`users_email_uq`). Internal signal: signup turns it into the generic
 * 202 path and provisioning into `created: false`; it must never reach a client as such.
 */
export class EmailAlreadyRegistered extends ConflictError {
  constructor(options: { cause?: unknown } = {}) {
    super('The email address is already registered.', {
      code: ErrorCode.Conflict,
      cause: options.cause,
    });
  }
}
