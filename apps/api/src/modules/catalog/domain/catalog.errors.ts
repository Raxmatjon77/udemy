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

/** 422 `markdown_not_allowed` (D14): raw HTML, images or unsafe links; `issues` per construct. */
export class MarkdownNotAllowed extends ValidationError {
  constructor(issues: readonly DomainFieldIssue[]) {
    super('The text contains markdown that is not allowed (HTML, images or unsafe links).', {
      code: ErrorCode.MarkdownNotAllowed,
      issues,
    });
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
