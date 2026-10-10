import type {
  CourseStatus,
  CourseTransitionAction,
  RevisionKind,
  RevisionState,
} from '@udemy/contracts';
import type { CourseLifecycle } from './course';
import {
  CourseNotEditable,
  InvalidStateTransition,
  RestoreForbidden,
  ReviewAlreadyPending,
  SelfDecisionForbidden,
  VersionConflict,
} from './catalog.errors';

/**
 * The course status machine of design §4 (and the `course_transitions_edge_ck` whitelist), as
 * pure functions. Each `plan*` validates the current lifecycle facts and returns the edge to
 * write; the use case then writes the course row and the transition with the same edge, and
 * the DB re-checks it (edge CHECK, chain FK, status <-> log at COMMIT).
 */

/** One edge of the machine: `fromStatus -> toStatus`. */
export interface Edge {
  readonly fromStatus: CourseStatus;
  readonly toStatus: CourseStatus;
}

export interface SubmitPlan extends Edge {
  /** INITIAL when nothing is live yet, otherwise UPDATE (`course_revisions_submit_log_ck`). */
  readonly kind: RevisionKind;
}

/**
 * SUBMIT: DRAFT|REJECTED -> IN_REVIEW; PUBLISHED -> PUBLISHED (an update of a live course).
 *
 * @throws ReviewAlreadyPending (409) when a revision is already in review (D2, invariant 9)
 * @throws CourseNotEditable (409) when ARCHIVED
 */
export function planSubmit(course: CourseLifecycle): SubmitPlan {
  if (course.pendingRevisionId !== null || course.status === 'IN_REVIEW') {
    throw new ReviewAlreadyPending();
  }
  switch (course.status) {
    case 'DRAFT':
    case 'REJECTED':
      return { fromStatus: course.status, toStatus: 'IN_REVIEW', kind: 'INITIAL' };
    case 'PUBLISHED':
      return { fromStatus: 'PUBLISHED', toStatus: 'PUBLISHED', kind: 'UPDATE' };
    case 'ARCHIVED':
      throw new CourseNotEditable();
  }
}

/**
 * WITHDRAW of the pending revision: IN_REVIEW -> DRAFT, or PUBLISHED -> PUBLISHED (an update).
 * Archiving uses the same edge for its automatic withdraw (reason `ARCHIVED`).
 *
 * @throws InvalidStateTransition (409) when nothing is pending
 */
export function planWithdraw(course: CourseLifecycle): Edge & { readonly revisionId: string } {
  const revisionId = course.pendingRevisionId;
  if (revisionId === null) throw new InvalidStateTransition();
  if (course.status === 'IN_REVIEW')
    return { fromStatus: 'IN_REVIEW', toStatus: 'DRAFT', revisionId };
  if (course.status === 'PUBLISHED') {
    return { fromStatus: 'PUBLISHED', toStatus: 'PUBLISHED', revisionId };
  }
  throw new InvalidStateTransition();
}

export interface DecisionInput {
  readonly ownerId: string;
  readonly actorId: string;
  /** The revision the admin looked at (invariant 9: decisions always name it). */
  readonly revisionId: string;
  readonly expectedVersion?: number;
}

/**
 * Guards shared by APPROVE and REJECT, in this order: the decider is not the owner
 * (invariant 8), the optimistic version matches, and the named revision is the pending one
 * (otherwise it was already decided, withdrawn or superseded).
 *
 * @throws SelfDecisionForbidden (403), VersionConflict (409), InvalidStateTransition (409)
 */
function assertDecidable(course: CourseLifecycle, input: DecisionInput): void {
  if (input.actorId === input.ownerId) throw new SelfDecisionForbidden();
  if (input.expectedVersion !== undefined && input.expectedVersion !== course.version) {
    throw new VersionConflict();
  }
  if (course.pendingRevisionId !== input.revisionId) throw new InvalidStateTransition();
  if (course.status !== 'IN_REVIEW' && course.status !== 'PUBLISHED') {
    throw new InvalidStateTransition();
  }
}

/**
 * APPROVE: IN_REVIEW|PUBLISHED -> PUBLISHED; the revision becomes live. `supersededRevisionId`
 * is the previous live revision, whose media pins are released (design §4 revision states).
 */
export function planApprove(
  course: CourseLifecycle,
  input: DecisionInput,
): Edge & { readonly supersededRevisionId: string | null } {
  assertDecidable(course, input);
  return {
    fromStatus: course.status,
    toStatus: 'PUBLISHED',
    supersededRevisionId: course.publishedRevisionId,
  };
}

/** REJECT: IN_REVIEW -> REJECTED (first submission); a live course stays PUBLISHED. */
export function planReject(course: CourseLifecycle, input: DecisionInput): Edge {
  assertDecidable(course, input);
  return course.status === 'IN_REVIEW'
    ? { fromStatus: 'IN_REVIEW', toStatus: 'REJECTED' }
    : { fromStatus: 'PUBLISHED', toStatus: 'PUBLISHED' };
}

/**
 * ARCHIVE (owner) / TAKEDOWN (admin): only a PUBLISHED course; a pending update is withdrawn
 * first (`pendingToWithdraw`, a WITHDRAW PUBLISHED -> PUBLISHED with reason `ARCHIVED`).
 *
 * @throws InvalidStateTransition (409) for any other status
 */
export function planArchive(
  course: CourseLifecycle,
): Edge & { readonly pendingToWithdraw: string | null } {
  if (course.status !== 'PUBLISHED') throw new InvalidStateTransition();
  return {
    fromStatus: 'PUBLISHED',
    toStatus: 'ARCHIVED',
    pendingToWithdraw: course.pendingRevisionId,
  };
}

/** The transition at the head of the chain (who archived the course). */
export interface HeadFacts {
  readonly action: CourseTransitionAction;
  readonly actorId: string;
}

/**
 * RESTORE: ARCHIVED -> PUBLISHED. An admin may always restore; the owner only a course they
 * archived themselves (invariant 10, `course_transitions_restore_actor_ck`). The head of an
 * ARCHIVED course's chain is always its ARCHIVE transition.
 *
 * @throws InvalidStateTransition (409) unless ARCHIVED, RestoreForbidden (403)
 */
export function planRestore(
  course: CourseLifecycle & { readonly ownerId: string },
  head: HeadFacts | null,
  byAdmin: boolean,
): Edge {
  if (course.status !== 'ARCHIVED') throw new InvalidStateTransition();
  if (!byAdmin && (head?.action !== 'ARCHIVE' || head.actorId !== course.ownerId)) {
    throw new RestoreForbidden();
  }
  return { fromStatus: 'ARCHIVED', toStatus: 'PUBLISHED' };
}

/**
 * The derived state of one revision (design §4; there is no status column): pending and live
 * come from the course pointers, the rest from the revision's decision transition.
 */
export function revisionState(
  course: Pick<CourseLifecycle, 'pendingRevisionId' | 'publishedRevisionId'>,
  revisionId: string,
  decision: 'APPROVE' | 'REJECT' | 'WITHDRAW' | null,
): RevisionState {
  if (course.pendingRevisionId === revisionId) return 'PENDING';
  if (course.publishedRevisionId === revisionId) return 'LIVE';
  switch (decision) {
    case 'APPROVE':
      return 'SUPERSEDED';
    case 'REJECT':
      return 'REJECTED';
    case 'WITHDRAW':
      return 'WITHDRAWN';
    case null:
      // A submitted revision is either pending or decided (courses_status_log_ck).
      throw new Error(`revision ${revisionId} is neither pending nor decided`);
  }
}
