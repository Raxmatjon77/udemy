import {
  AttachedMediaUnusable,
  CategoryDepthExceeded,
  CategoryNotFound,
  CategoryNotLeaf,
  CourseInReview,
  CourseNotFound,
  CurriculumLimitExceeded,
  InvalidCatalogField,
  InvalidStateTransition,
  LectureTypeMismatch,
  OrderMismatch,
  PreviewNotAllowed,
  RestoreForbidden,
  ReviewAlreadyPending,
  SelfDecisionForbidden,
  SlugFrozen,
  SlugTaken,
  VersionConflict,
} from '../domain/catalog.errors';

interface PgErrorLike {
  code: string;
  constraint?: string;
}

export function isPgError(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** 23503 foreign_key_violation. */
export function isForeignKeyViolation(error: unknown): boolean {
  return isPgError(error) && error.code === '23503';
}

type ToDomainError = (cause: unknown) => Error;

const field =
  (path: string, message: string): ToDomainError =>
  (cause) =>
    new InvalidCatalogField({ path, message }, { cause });

/**
 * Constraint name -> domain error for the `catalog` tables (schema doc §9; for unique indexes
 * and trigger pseudo-constraints `err.constraint` is the name below). Deferred constraints
 * raise at COMMIT; the transaction runner maps those too.
 *
 * Not listed, so a 500 (programming errors, logged by the global filter):
 * `courses_status_log_ck`, `course_revisions_submit_log_ck`, `course_revisions_complete_ck`,
 * `courses_status_pointers_ck` and the other lifecycle shape CHECKs, `course_transitions_actor_ck`,
 * `*_immutable_ck`, and 42501 from the append-only guards.
 *
 * Context-dependent cases are mapped by the repository instead: any 23503 while DELETING a
 * category is `category_in_use`.
 */
export const CATALOG_CONSTRAINT_ERRORS: Readonly<Record<string, ToDomainError>> = {
  // D12 slugs
  courses_slug_active_uq: (cause) => new SlugTaken({ cause }),
  categories_slug_uq: (cause) => new SlugTaken({ cause }),
  courses_slug_frozen_ck: (cause) => new SlugFrozen({ cause }),
  // Category tree shape
  categories_depth_ck: (cause) => new CategoryDepthExceeded({ cause }),
  categories_depth_parent_id_ck: (cause) => new CategoryDepthExceeded({ cause }),
  categories_parent_id_parent_depth_fk: (cause) => new CategoryNotFound({ cause }),
  courses_category_id_category_depth_fk: (cause) => new CategoryNotLeaf({ cause }),
  // D3 positions (deferred, raised at COMMIT): a concurrent edit slipped past the lock
  categories_parent_id_position_uq: (cause) => new OrderMismatch({ cause }),
  sections_course_id_position_uq: (cause) => new OrderMismatch({ cause }),
  lectures_section_id_position_uq: (cause) => new OrderMismatch({ cause }),
  // Curriculum limits (contiguous positions bound the counts)
  sections_position_ck: (cause) =>
    new CurriculumLimitExceeded('A course can have at most 50 sections.', { cause }),
  lectures_position_ck: (cause) =>
    new CurriculumLimitExceeded('A section can have at most 100 lectures.', { cause }),
  course_bullets_position_ck: (cause) =>
    new CurriculumLimitExceeded('At most 10 outcomes and 10 requirements.', { cause }),
  // D2 review lock (header trigger + children guard)
  courses_working_copy_locked_ck: (cause) => new CourseInReview({ cause }),
  // Lecture type rules
  lectures_type_media_asset_id_ck: (cause) => new LectureTypeMismatch(undefined, { cause }),
  lecture_articles_lecture_id_lecture_type_fk: (cause) =>
    new LectureTypeMismatch(undefined, { cause }),
  lectures_type_is_preview_ck: (cause) => new PreviewNotAllowed(undefined, { cause }),
  // One working consumer per asset (catalog's own backstops; MediaFacade reports it first)
  lectures_media_asset_id_uq: (cause) => new AttachedMediaUnusable({ cause }),
  courses_thumbnail_asset_id_uq: (cause) => new AttachedMediaUnusable({ cause }),
  // Lifecycle log and revisions (P2-T9 writes CREATE/DELETE; P2-T10 the rest)
  course_transitions_course_deleted_ck: (cause) => new CourseNotFound({ cause }),
  course_transitions_course_id_prev_transition_id_uq: (cause) => new VersionConflict({ cause }),
  course_transitions_revision_id_decision_uq: (cause) => new InvalidStateTransition({ cause }),
  course_transitions_revision_id_submit_uq: (cause) => new InvalidStateTransition({ cause }),
  course_transitions_course_id_delete_uq: (cause) => new InvalidStateTransition({ cause }),
  course_transitions_edge_ck: (cause) => new InvalidStateTransition({ cause }),
  course_transitions_course_id_prev_transition_id_from_status_fk: (cause) =>
    new InvalidStateTransition({ cause }),
  course_transitions_self_decision_ck: (cause) => new SelfDecisionForbidden({ cause }),
  course_transitions_restore_actor_ck: (cause) => new RestoreForbidden({ cause }),
  course_revisions_course_id_revision_no_uq: (cause) => new ReviewAlreadyPending({ cause }),
  // One pending revision per course (two submits can only race past a missing lock)
  courses_pending_revision_id_uq: (cause) => new ReviewAlreadyPending({ cause }),
  // Moderation reasons (the request schemas check them first)
  course_transitions_takedown_reason_ck: field(
    'reason',
    'A takedown needs a reason of at least 10 characters.',
  ),
  course_transitions_reject_reason_ck: field(
    'reason',
    'A rejection needs a reason of at least 10 characters.',
  ),
  course_transitions_reason_ck: field('reason', 'Invalid reason.'),
  course_revisions_submitter_note_ck: field('note', 'Invalid note.'),
  // Field shapes the request schemas already enforce (a hit is a validation gap: still 422)
  courses_title_ck: field('title', 'Invalid title.'),
  courses_subtitle_ck: field('subtitle', 'Invalid subtitle.'),
  courses_description_md_ck: field('descriptionMd', 'Invalid description.'),
  courses_language_ck: field('language', 'Invalid language.'),
  courses_level_ck: field('level', 'Invalid level.'),
  courses_slug_ck: field('slug', 'Invalid slug.'),
  course_bullets_text_ck: field('outcomes', 'Invalid outcome or requirement.'),
  sections_title_ck: field('title', 'Invalid section title.'),
  sections_objective_ck: field('objective', 'Invalid section objective.'),
  lectures_title_ck: field('title', 'Invalid lecture title.'),
  lectures_description_md_ck: field('descriptionMd', 'Invalid lecture description.'),
  lecture_articles_body_md_ck: field('bodyMd', 'Invalid article body.'),
  categories_name_ck: field('name', 'Invalid category name.'),
  categories_slug_ck: field('slug', 'Invalid slug.'),
};

/** Re-throws a known constraint violation as its domain error; anything else unchanged. */
export function rethrowCatalogConstraint(error: unknown): never {
  if (isPgError(error) && error.constraint !== undefined) {
    const toError = CATALOG_CONSTRAINT_ERRORS[error.constraint];
    if (toError !== undefined) throw toError(error);
  }
  throw error;
}

/** Runs a statement and maps its constraint violations. */
export async function mapCatalogConstraints<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowCatalogConstraint(error);
  }
}
