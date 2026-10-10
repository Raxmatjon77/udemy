import { ErrorCode } from '@udemy/contracts';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@udemy/nest-common/errors';

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
