import type {
  AdminEnrollment,
  Enrollment as EnrollmentView,
  EnrollmentTransition as EnrollmentTransitionView,
} from '@udemy/contracts';
import type { CourseSummary } from '../../catalog';
import type { Enrollment, EnrollmentTransition } from '../domain/enrollment';
import { transitionId } from './ids';

/** Domain row -> HTTP `Enrollment` (timestamps as ISO 8601 UTC). */
export function toEnrollmentView(enrollment: Enrollment): EnrollmentView {
  return {
    id: enrollment.id,
    userId: enrollment.userId,
    courseId: enrollment.courseId,
    status: enrollment.status,
    source: enrollment.source,
    orderLineId: enrollment.orderLineId,
    grantedAt: enrollment.grantedAt.toISOString(),
    revokedAt: enrollment.revokedAt?.toISOString() ?? null,
    revokeReason: enrollment.revokeReason,
  };
}

/** Transition row -> HTTP `EnrollmentTransition` (a derived stable id, see `transitionId`). */
export function toTransitionView(transition: EnrollmentTransition): EnrollmentTransitionView {
  return {
    id: transitionId(transition.enrollmentId, transition.seq),
    action: transition.action,
    source: transition.source,
    orderLineId: transition.orderLineId,
    refundId: transition.refundId,
    reason: transition.reason,
    actorId: transition.actorId,
    occurredAt: transition.occurredAt.toISOString(),
  };
}

/**
 * HTTP `AdminEnrollment`. `course` is null-titled when catalog no longer has a live revision
 * for it (deleted course; enrollments are never deleted).
 */
export function toAdminEnrollmentView(
  enrollment: Enrollment,
  transitions: readonly EnrollmentTransition[],
  course: CourseSummary | undefined,
): AdminEnrollment {
  return {
    ...toEnrollmentView(enrollment),
    course: {
      id: enrollment.courseId,
      slug: course?.slug ?? null,
      title: course?.title ?? null,
      archived: course?.status === 'ARCHIVED',
    },
    transitions: [...transitions].sort((a, b) => a.seq - b.seq).map(toTransitionView),
  };
}
