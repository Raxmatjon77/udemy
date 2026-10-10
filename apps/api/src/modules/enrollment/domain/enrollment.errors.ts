import { ErrorCode } from '@udemy/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@udemy/nest-common/errors';

interface CauseOption {
  readonly cause?: unknown;
}

/* ----------------------------------------------------------------------------------------
 * Lookups (404)
 * -------------------------------------------------------------------------------------- */

/** 404 `enrollment_not_found` (admin revoke of an unknown id). */
export class EnrollmentNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The enrollment does not exist.', {
      code: ErrorCode.EnrollmentNotFound,
      cause: options.cause,
    });
  }
}

/** 404 `course_not_found`: no course with a live revision (never published, or deleted). */
export class CourseNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The course does not exist.', { code: ErrorCode.CourseNotFound, cause: options.cause });
  }
}

/** 404 `user_not_found` (admin views and grants for an unknown user). */
export class UserNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The user does not exist.', { code: ErrorCode.UserNotFound, cause: options.cause });
  }
}

/* ----------------------------------------------------------------------------------------
 * Eligibility and state (409)
 * -------------------------------------------------------------------------------------- */

/** 409 `already_enrolled` (admin grant while the enrollment is ACTIVE). */
export class AlreadyEnrolled extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The user is already enrolled in this course.', {
      code: ErrorCode.AlreadyEnrolled,
      cause: options.cause,
    });
  }
}

/** 409 `course_not_for_sale`: not PUBLISHED (archived), or it has no price yet (D16). */
export class CourseNotForSale extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The course is not available for enrollment.', {
      code: ErrorCode.CourseNotForSale,
      cause: options.cause,
    });
  }
}

/** 409 `course_not_free`: a free enrollment on a paid course (buy it instead). */
export class CourseNotFree extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The course is not free. Purchase it to enroll.', {
      code: ErrorCode.CourseNotFree,
      cause: options.cause,
    });
  }
}

/** 409 `cannot_purchase_own_course`: instructors already have access to their own courses. */
export class CannotPurchaseOwnCourse extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('You cannot enroll in your own course.', {
      code: ErrorCode.CannotPurchaseOwnCourse,
      cause: options.cause,
    });
  }
}

/** 409 `invalid_state_transition`: e.g. revoking an enrollment that is not ACTIVE. */
export class InvalidStateTransition extends ConflictError {
  constructor(
    message = 'The enrollment is not in a state that allows this action.',
    options: CauseOption = {},
  ) {
    super(message, { code: ErrorCode.InvalidStateTransition, cause: options.cause });
  }
}

/* ----------------------------------------------------------------------------------------
 * Validation (422)
 * -------------------------------------------------------------------------------------- */

/** 422 `validation_failed` on `reason`: admin actions need a reason of 10–2000 characters. */
export class InvalidEnrollmentReason extends ValidationError {
  constructor(options: CauseOption = {}) {
    const message = 'An admin action needs a reason of 10 to 2000 characters.';
    super(message, {
      code: ErrorCode.ValidationFailed,
      issues: [{ path: 'reason', message }],
      cause: options.cause,
    });
  }
}
