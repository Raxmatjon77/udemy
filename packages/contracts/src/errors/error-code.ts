import { z } from 'zod';

/**
 * Stable, machine-readable problem `code` values (RFC 7807 extension member).
 * Clients branch on these, never on `title`/`detail`, so a value must never change once
 * released. The HTTP status for each code is decided by the api (DomainError kind).
 */
export const ErrorCode = {
  // Generic
  ValidationFailed: 'validation_failed',
  NotFound: 'not_found',
  Conflict: 'conflict',
  Forbidden: 'forbidden',
  Unauthorized: 'unauthorized',
  RateLimited: 'rate_limited',
  ServiceUnavailable: 'service_unavailable',
  Internal: 'internal',

  // identity: authentication and sessions
  InvalidCredentials: 'invalid_credentials',
  TooManyAttempts: 'too_many_attempts',
  AccountBanned: 'account_banned',
  AppAccessDenied: 'app_access_denied',
  ClientNotAllowed: 'client_not_allowed',
  InvalidRefreshToken: 'invalid_refresh_token',
  /** Access token expired; the BFF refreshes once and retries (design §10). */
  TokenExpired: 'token_expired',
  SessionNotFound: 'session_not_found',

  // identity: passwords and email
  WeakPassword: 'weak_password',
  InvalidCurrentPassword: 'invalid_current_password',
  /** Invalid, expired or already used one-time token (email verification / password reset). */
  InvalidToken: 'invalid_token',
  EmailAlreadyVerified: 'email_already_verified',
  EmailNotVerified: 'email_not_verified',

  // identity / users: accounts and bans
  UserNotFound: 'user_not_found',
  AlreadyBanned: 'already_banned',
  NotBanned: 'not_banned',
  CannotBanSelf: 'cannot_ban_self',
  TargetIsAdmin: 'target_is_admin',

  // access
  RoleNotAssignable: 'role_not_assignable',

  // users: instructor applications
  ApplicationAlreadyPending: 'application_already_pending',
  AlreadyInstructor: 'already_instructor',
  InvalidStateTransition: 'invalid_state_transition',
  VersionConflict: 'version_conflict',
  SelfDecisionForbidden: 'self_decision_forbidden',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES = Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}

/**
 * The type of `ProblemDetails.code`: every known code autocompletes, but any string is
 * still accepted (DomainError codes are plain strings, and future codes must not break
 * older clients).
 */
export type ProblemCode = ErrorCode | (string & {});
