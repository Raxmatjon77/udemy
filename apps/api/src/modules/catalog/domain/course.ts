import type { CourseBadge, CourseStatus, CourseTransitionAction } from '@udemy/contracts';
import {
  CourseInReview,
  CourseNotEditable,
  CoursePublishedCannotDelete,
  SlugFrozen,
  VersionConflict,
} from './catalog.errors';

export type { CourseBadge, CourseStatus };

/** The lifecycle facts of a course that the working-copy rules depend on. */
export interface CourseLifecycle {
  readonly status: CourseStatus;
  readonly version: number;
  readonly pendingRevisionId: string | null;
  readonly publishedRevisionId: string | null;
  readonly firstPublishedAt: Date | null;
}

/**
 * Invariant 1 (design §4, D2): the working copy is mutable only when no revision is pending and
 * the status is DRAFT, REJECTED or PUBLISHED. (`deletedAt` is excluded by the lookup: a deleted
 * course does not exist for any use case.)
 *
 * @throws CourseInReview (409) while a revision is pending
 * @throws CourseNotEditable (409) when ARCHIVED (or any other non-editable status)
 */
export function assertWorkingCopyEditable(course: CourseLifecycle): void {
  if (course.pendingRevisionId !== null || course.status === 'IN_REVIEW') {
    throw new CourseInReview();
  }
  if (!isEditableStatus(course.status)) throw new CourseNotEditable();
}

/** DRAFT, REJECTED and PUBLISHED working copies can be edited (when nothing is pending). */
export function isEditableStatus(status: CourseStatus): boolean {
  return status === 'DRAFT' || status === 'REJECTED' || status === 'PUBLISHED';
}

/** The working copy is read-only: a revision is pending, or the course is archived. */
export function isWorkingCopyLocked(course: CourseLifecycle): boolean {
  return course.pendingRevisionId !== null || !isEditableStatus(course.status);
}

/** Optimistic lock: a stale `expectedVersion` is 409 `version_conflict`. */
export function assertExpectedVersion(course: CourseLifecycle, expected: number | undefined): void {
  if (expected !== undefined && expected !== course.version) throw new VersionConflict();
}

/** Invariant 2 (D12): the slug is editable until the first publication. */
export function isSlugEditable(course: Pick<CourseLifecycle, 'firstPublishedAt'>): boolean {
  return course.firstPublishedAt === null;
}

/** @throws SlugFrozen (409) once the course was published */
export function assertSlugEditable(course: Pick<CourseLifecycle, 'firstPublishedAt'>): void {
  if (!isSlugEditable(course)) throw new SlugFrozen();
}

/**
 * Invariant 11 (D13): only a never-published course without a pending revision can be
 * (soft-)deleted; a published one must be archived.
 *
 * @throws CoursePublishedCannotDelete (409), CourseInReview (409)
 */
export function assertDeletable(course: CourseLifecycle): void {
  if (course.firstPublishedAt !== null || course.publishedRevisionId !== null) {
    throw new CoursePublishedCannotDelete();
  }
  if (course.pendingRevisionId !== null || course.status === 'IN_REVIEW') {
    throw new CourseInReview();
  }
  if (course.status !== 'DRAFT' && course.status !== 'REJECTED') throw new CourseNotEditable();
}

/**
 * Derived badge (contracts `COURSE_BADGES`, never stored): the status, the pending pointer and
 * the action at the head of the transition chain. A PUBLISHED course shows an update in
 * review, or that its most recent transition rejected an update (the live revision is
 * unchanged); any later transition (resubmit, withdraw, archive + restore) clears that.
 */
export function courseBadge(
  course: Pick<CourseLifecycle, 'status' | 'pendingRevisionId'>,
  headAction: CourseTransitionAction | null,
): CourseBadge {
  switch (course.status) {
    case 'DRAFT':
    case 'IN_REVIEW':
    case 'REJECTED':
    case 'ARCHIVED':
      return course.status;
    case 'PUBLISHED':
      if (course.pendingRevisionId !== null) return 'LIVE_UPDATE_PENDING';
      return headAction === 'REJECT' ? 'LIVE_UPDATE_REJECTED' : 'LIVE';
  }
}
