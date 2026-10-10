import { ErrorCode } from '@udemy/contracts';
import {
  ConflictError,
  type DomainFieldIssue,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@udemy/nest-common/errors';

interface CauseOption {
  readonly cause?: unknown;
}

/* ----------------------------------------------------------------------------------------
 * Instructor applications
 * -------------------------------------------------------------------------------------- */

/** 404 `not_found`: unknown application, or another user's (no ID probing, design §9). */
export class InstructorApplicationNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The instructor application does not exist.', {
      code: ErrorCode.NotFound,
      cause: options.cause,
    });
  }
}

/** 409 `invalid_state_transition`: only PENDING applications can change state. */
export class InvalidStateTransition extends ConflictError {
  constructor(options: CauseOption & { from?: string; to?: string } = {}) {
    const detail =
      options.from === undefined
        ? 'The application can no longer change state.'
        : `The application is ${options.from} and can no longer change state.`;
    super(detail, {
      code: ErrorCode.InvalidStateTransition,
      cause: options.cause,
    });
  }
}

/** 409 `version_conflict`: `expectedVersion` is stale (someone decided in the meantime). */
export class VersionConflict extends ConflictError {
  constructor() {
    super('The application was changed by someone else. Reload and try again.', {
      code: ErrorCode.VersionConflict,
    });
  }
}

/** 403 `self_decision_forbidden`: an applicant cannot approve or reject their own application. */
export class SelfDecisionForbidden extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('You cannot decide your own instructor application.', {
      code: ErrorCode.SelfDecisionForbidden,
      cause: options.cause,
    });
  }
}

/** 409 `application_already_pending`: at most one PENDING application per applicant. */
export class ApplicationAlreadyPending extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('You already have a pending instructor application.', {
      code: ErrorCode.ApplicationAlreadyPending,
      cause: options.cause,
    });
  }
}

/** 409 `already_instructor`. */
export class AlreadyInstructor extends ConflictError {
  constructor() {
    super('You are already an instructor.', { code: ErrorCode.AlreadyInstructor });
  }
}

/** 403 `email_not_verified`: applying needs a verified email (checked fresh, design §13). */
export class EmailNotVerified extends ForbiddenError {
  constructor() {
    super('Verify your email address before applying.', { code: ErrorCode.EmailNotVerified });
  }
}

/** 403 `account_banned`: a banned account cannot apply. */
export class ApplicantBanned extends ForbiddenError {
  constructor() {
    super('This account has been suspended.', { code: ErrorCode.AccountBanned });
  }
}

/* ----------------------------------------------------------------------------------------
 * Users, profiles, bans
 * -------------------------------------------------------------------------------------- */

/** 404 `user_not_found`: unknown user, or (public profile) a banned one. */
export class UserNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The user does not exist.', { code: ErrorCode.UserNotFound, cause: options.cause });
  }
}

/** 409 `target_is_admin`: an ADMIN holder cannot be banned (revoke the role first). */
export class TargetIsAdmin extends ConflictError {
  constructor() {
    super('Administrators cannot be banned.', { code: ErrorCode.TargetIsAdmin });
  }
}

/** 422 `validation_failed` for one field of an application or profile. */
export class InvalidUsersField extends ValidationError {
  constructor(issue: DomainFieldIssue) {
    super(issue.message, { code: ErrorCode.ValidationFailed, issues: [issue] });
  }
}
