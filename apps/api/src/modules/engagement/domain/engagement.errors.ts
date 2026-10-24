import { ErrorCode, type MarkdownConstruct, type MarkdownIssueKind } from '@udemy/contracts';
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
 * Q&A (D12)
 * -------------------------------------------------------------------------------------- */

/** 404 `lecture_not_found`: the lecture is not part of the course's live revision. */
export class LectureNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The lecture does not exist in this course.', {
      code: ErrorCode.LectureNotFound,
      cause: options.cause,
    });
  }
}

/** 404 `question_not_found`: unknown, in another course, deleted, or hidden from the caller. */
export class QuestionNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The question does not exist.', {
      code: ErrorCode.QuestionNotFound,
      cause: options.cause,
    });
  }
}

/** 404 `answer_not_found`: unknown, of another question/course, deleted, or hidden. */
export class AnswerNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The answer does not exist.', { code: ErrorCode.AnswerNotFound, cause: options.cause });
  }
}

/** 403 `not_content_author`: only the author may edit or delete (accept: author or owner). */
export class NotContentAuthor extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('Only the author can do this.', {
      code: ErrorCode.NotContentAuthor,
      cause: options.cause,
    });
  }
}

/** 422 `cannot_vote_own_content`. */
export class CannotVoteOwnContent extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('You cannot vote on your own content.', {
      code: ErrorCode.CannotVoteOwnContent,
      cause: options.cause,
    });
  }
}

/** 422 `markdown_not_allowed` (D22): HTML, images or unsafe links in a markdown body. */
export interface EngagementMarkdownIssue {
  /** The request field (`bodyMd`). */
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly kind: MarkdownIssueKind;
  readonly construct: MarkdownConstruct;
  readonly detail: string;
}

export class MarkdownNotAllowed extends ValidationError {
  readonly markdownIssues: readonly EngagementMarkdownIssue[];

  constructor(markdownIssues: readonly EngagementMarkdownIssue[]) {
    super('The text contains markdown that is not allowed (HTML, images or unsafe links).', {
      code: ErrorCode.MarkdownNotAllowed,
      issues: markdownIssues.map((issue) => ({
        path: issue.path,
        message: `Line ${issue.line}, column ${issue.column}: ${issue.detail} (${issue.kind}).`,
      })),
    });
    this.markdownIssues = markdownIssues;
  }
}

/* ----------------------------------------------------------------------------------------
 * Announcements (D18)
 * -------------------------------------------------------------------------------------- */

/** 404 `announcement_not_found`: unknown, of another course, or already deleted. */
export class AnnouncementNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The announcement does not exist.', {
      code: ErrorCode.AnnouncementNotFound,
      cause: options.cause,
    });
  }
}

/**
 * 422 `announcement_limit_exceeded` (`AnnouncementLimitProblem`): the course posted
 * `ANNOUNCEMENT_LIMITS.perCourse` announcements in the last `windowDays` days. `retryAt` is
 * when the oldest counted one leaves the window (rendered as an extension member).
 */
export class AnnouncementLimitExceeded extends ValidationError {
  constructor(readonly retryAt: Date) {
    super('This course reached its announcement limit. Try again later.', {
      code: ErrorCode.AnnouncementLimitExceeded,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Moderation (D13)
 * -------------------------------------------------------------------------------------- */

/**
 * 409 `invalid_state_transition`: hiding hidden content without open reports, restoring visible
 * content, dismissing when nothing is open, or hiding/restoring deleted content.
 */
export class InvalidModerationTransition extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This moderation action does not apply to the content in its current state.', {
      code: ErrorCode.InvalidStateTransition,
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
