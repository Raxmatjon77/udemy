import { ErrorCode } from '@udemy/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@udemy/nest-common/errors';

interface CauseOption {
  readonly cause?: unknown;
}

/* ----------------------------------------------------------------------------------------
 * Lookups (404)
 * -------------------------------------------------------------------------------------- */

/** 404 `course_not_found`: no course with a live revision (never published, or deleted). */
export class CourseNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The course does not exist.', { code: ErrorCode.CourseNotFound, cause: options.cause });
  }
}

/** 404 `review_not_found`: unknown, deleted, in another course, or not visible to the caller. */
export class ReviewNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The review does not exist.', { code: ErrorCode.ReviewNotFound, cause: options.cause });
  }
}

/** 404 `reply_not_found`: the review has no live reply (or it is not visible to the caller). */
export class ReplyNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The reply does not exist.', { code: ErrorCode.ReplyNotFound, cause: options.cause });
  }
}

/* ----------------------------------------------------------------------------------------
 * Review eligibility (D10, P5-D8)
 * -------------------------------------------------------------------------------------- */

/** 403 `enrollment_required`: reviewing needs an ACTIVE enrollment. */
export class EnrollmentRequired extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('An active enrollment in this course is required.', {
      code: ErrorCode.EnrollmentRequired,
      cause: options.cause,
    });
  }
}

/** 403 `cannot_review_own_course`. */
export class CannotReviewOwnCourse extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('You cannot review your own course.', {
      code: ErrorCode.CannotReviewOwnCourse,
      cause: options.cause,
    });
  }
}

/** 422 `review_not_eligible`: enrolled, but no lecture of the course completed yet. */
export class ReviewNotEligible extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Complete at least one lecture of this course before reviewing it.', {
      code: ErrorCode.ReviewNotEligible,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Wishlist (D19)
 * -------------------------------------------------------------------------------------- */

/** 409 `course_not_wishlistable`: not PUBLISHED, owned by the caller, or already enrolled. */
export class CourseNotWishlistable extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This course cannot be added to your wishlist.', {
      code: ErrorCode.CourseNotWishlistable,
      cause: options.cause,
    });
  }
}

/** 422 `wishlist_full`: `WISHLIST_LIMITS.maxItems` reached. */
export class WishlistFull extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Your wishlist is full. Remove a course to add another one.', {
      code: ErrorCode.WishlistFull,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Reports (D13)
 * -------------------------------------------------------------------------------------- */

/** 422 `cannot_report_own_content`. */
export class CannotReportOwnContent extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('You cannot report your own content.', {
      code: ErrorCode.CannotReportOwnContent,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Shape violations the request schemas already exclude (a DB CHECK is the backstop)
 * -------------------------------------------------------------------------------------- */

/** 422 `validation_failed` from a content CHECK (rating, body, reason, comment). */
export class InvalidEngagementInput extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('The content is not valid.', { code: ErrorCode.ValidationFailed, cause: options.cause });
  }
}
