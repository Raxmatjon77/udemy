import { type CourseReadinessIssue, ErrorCode, type MarkdownIssue } from '@udemy/contracts';
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
 * Lookups (404). Foreign courses never reach a use case (the course policy answers 404);
 * children are always loaded scoped by their course, so another course's id is "not found".
 * -------------------------------------------------------------------------------------- */

export class CourseNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The course does not exist.', { code: ErrorCode.CourseNotFound, cause: options.cause });
  }
}

export class SectionNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The section does not exist in this course.', {
      code: ErrorCode.SectionNotFound,
      cause: options.cause,
    });
  }
}

export class LectureNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The lecture does not exist in this course.', {
      code: ErrorCode.LectureNotFound,
      cause: options.cause,
    });
  }
}

export class CategoryNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The category does not exist.', {
      code: ErrorCode.CategoryNotFound,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Working copy (409)
 * -------------------------------------------------------------------------------------- */

/** 409 `course_in_review`: a revision is pending, the working copy is read-only (D2). */
export class CourseInReview extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The course is in review. Withdraw the submission to edit it.', {
      code: ErrorCode.CourseInReview,
      cause: options.cause,
    });
  }
}

/** 409 `course_not_editable`: archived (or otherwise not in an editable state). */
export class CourseNotEditable extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The course cannot be edited in its current state.', {
      code: ErrorCode.CourseNotEditable,
      cause: options.cause,
    });
  }
}

/** 409 `version_conflict`: `expectedVersion` is stale, or a concurrent transition won. */
export class VersionConflict extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The course was changed by someone else. Reload it and try again.', {
      code: ErrorCode.VersionConflict,
      cause: options.cause,
    });
  }
}

/** 409 `slug_taken` (course slug among non-deleted courses, or category slug). */
export class SlugTaken extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This URL slug is already taken.', { code: ErrorCode.SlugTaken, cause: options.cause });
  }
}

/** 409 `slug_frozen`: the course was published once, its URL never changes again (D12). */
export class SlugFrozen extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The URL slug cannot change after the course was published.', {
      code: ErrorCode.SlugFrozen,
      cause: options.cause,
    });
  }
}

/** 409 `course_published_cannot_delete`: archive it instead (D13). */
export class CoursePublishedCannotDelete extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('A course that was published cannot be deleted; archive it instead.', {
      code: ErrorCode.CoursePublishedCannotDelete,
      cause: options.cause,
    });
  }
}

/** 409 `invalid_state_transition`: an illegal or repeated lifecycle transition. */
export class InvalidStateTransition extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('This action is not possible in the current state of the course.', {
      code: ErrorCode.InvalidStateTransition,
      cause: options.cause,
    });
  }
}

/** 409 `review_already_pending` (P2-T10: concurrent submit). */
export class ReviewAlreadyPending extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('A submission of this course is already in review.', {
      code: ErrorCode.ReviewAlreadyPending,
      cause: options.cause,
    });
  }
}

/** 404 `not_found`: no such revision of this course (there is no dedicated revision code). */
export class RevisionNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The revision does not exist for this course.', {
      code: ErrorCode.NotFound,
      cause: options.cause,
    });
  }
}

/**
 * 422 `course_not_ready` (invariant 6): every unmet readiness rule at once. The presentation
 * layer renders `issues` as the `CourseNotReadyProblem` extension member (not field errors).
 */
export class CourseNotReady extends ValidationError {
  constructor(
    readonly readinessIssues: readonly CourseReadinessIssue[],
    options: CauseOption = {},
  ) {
    super('The course is not ready to be submitted for review.', {
      code: ErrorCode.CourseNotReady,
      cause: options.cause,
    });
  }
}

/** 409 `nothing_to_review` (invariant 7): the snapshot equals the live revision. */
export class NothingToReview extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('Nothing changed since the live version of the course.', {
      code: ErrorCode.NothingToReview,
      cause: options.cause,
    });
  }
}

/** 403 `self_decision_forbidden` (P2-T10: the owner deciding their own revision). */
export class SelfDecisionForbidden extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('You cannot review your own course.', {
      code: ErrorCode.SelfDecisionForbidden,
      cause: options.cause,
    });
  }
}

/** 403 `restore_forbidden` (P2-T10: the owner restoring an admin takedown). */
export class RestoreForbidden extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('Only a moderator can restore this course.', {
      code: ErrorCode.RestoreForbidden,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Public read and playback (P2-T11)
 * -------------------------------------------------------------------------------------- */

/**
 * 403 `lecture_locked`: the lecture is part of a live course (its outline is public), but the
 * viewer is neither the owner, a moderator nor entitled, and it is not a free preview.
 */
export class LectureLocked extends ForbiddenError {
  constructor(options: CauseOption = {}) {
    super('This lecture is not a free preview. Enroll in the course to watch it.', {
      code: ErrorCode.LectureLocked,
      cause: options.cause,
    });
  }
}

/** 404 `course_not_found` (contracts): the course working copy has no thumbnail. */
export class ThumbnailNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The course has no thumbnail.', {
      code: ErrorCode.CourseNotFound,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Curriculum
 * -------------------------------------------------------------------------------------- */

/** 409 `order_mismatch`: not an exact permutation of the current ids (D3). Refetch and retry. */
export class OrderMismatch extends ConflictError {
  constructor(options: CauseOption & { detail?: string } = {}) {
    super(options.detail ?? 'The order does not match the current items. Reload and try again.', {
      code: ErrorCode.OrderMismatch,
      cause: options.cause,
    });
  }
}

/** 422 `curriculum_limit_exceeded`. */
export class CurriculumLimitExceeded extends ValidationError {
  constructor(message: string, options: CauseOption = {}) {
    super(message, { code: ErrorCode.CurriculumLimitExceeded, cause: options.cause });
  }
}

/** 422 `lecture_type_mismatch`: media on an ARTICLE, an article body on a VIDEO, ... */
export class LectureTypeMismatch extends ValidationError {
  constructor(message = 'This is not possible for this lecture type.', options: CauseOption = {}) {
    super(message, { code: ErrorCode.LectureTypeMismatch, cause: options.cause });
  }
}

/** 422 `preview_not_allowed`: RESOURCE lectures, or more than the preview limit. */
export class PreviewNotAllowed extends ValidationError {
  constructor(message = 'This lecture cannot be a free preview.', options: CauseOption = {}) {
    super(message, {
      code: ErrorCode.PreviewNotAllowed,
      cause: options.cause,
      issues: [{ path: 'isPreview', message }],
    });
  }
}

/**
 * 409 `media_asset_unusable` raised by catalog's own uniqueness backstops
 * (`lectures_media_asset_id_uq`, `courses_thumbnail_asset_id_uq`): the asset is attached
 * elsewhere. MediaFacade normally reports this first from the usage row.
 */
export class AttachedMediaUnusable extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The media asset is already in use elsewhere.', {
      code: ErrorCode.MediaAssetUnusable,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Categories
 * -------------------------------------------------------------------------------------- */

/** 422 `category_inactive`: the category (or its group) is deactivated. */
export class CategoryInactive extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('The category is not active.', {
      code: ErrorCode.CategoryInactive,
      cause: options.cause,
      issues: [{ path: 'categoryId', message: 'The category is not active.' }],
    });
  }
}

/** 422 `category_not_leaf`: courses use depth-2 categories only. */
export class CategoryNotLeaf extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Choose a subcategory, not a category group.', {
      code: ErrorCode.CategoryNotLeaf,
      cause: options.cause,
      issues: [{ path: 'categoryId', message: 'Choose a subcategory.' }],
    });
  }
}

/** 422 `category_depth_exceeded`: the tree has exactly two levels. */
export class CategoryDepthExceeded extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('Categories can only be nested one level deep.', {
      code: ErrorCode.CategoryDepthExceeded,
      cause: options.cause,
      issues: [{ path: 'parentId', message: 'The parent must be a top-level category.' }],
    });
  }
}

/** 409 `category_in_use`: has children or is referenced by a course or revision. */
export class CategoryInUse extends ConflictError {
  constructor(options: CauseOption = {}) {
    super('The category is in use. Deactivate it instead.', {
      code: ErrorCode.CategoryInUse,
      cause: options.cause,
    });
  }
}

/* ----------------------------------------------------------------------------------------
 * Input rules (422)
 * -------------------------------------------------------------------------------------- */

/**
 * 422 `markdown_not_allowed` (D14): raw HTML, images or unsafe links, or markdown too complex to
 * process. `markdownIssues` is the structured form (contracts `MarkdownIssue`: path, line,
 * column, kind, construct, detail); `issues` keeps one `{ path, message }` per construct for the
 * generic `errors[]`. The presentation layer renders both (`MarkdownNotAllowedProblem`).
 */
export class MarkdownNotAllowed extends ValidationError {
  readonly markdownIssues: readonly MarkdownIssue[];

  constructor(markdownIssues: readonly MarkdownIssue[]) {
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

/** 422 `validation_failed` for one field (a DB CHECK the request schema did not catch). */
export class InvalidCatalogField extends ValidationError {
  constructor(issue: DomainFieldIssue, options: CauseOption = {}) {
    super(issue.message, {
      code: ErrorCode.ValidationFailed,
      issues: [issue],
      cause: options.cause,
    });
  }
}
