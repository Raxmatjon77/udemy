import {
  ENROLLMENT_REVOKE_REASONS,
  ENROLLMENT_SOURCES,
  ENROLLMENT_STATUSES,
  ENROLLMENT_TRANSITION_ACTIONS,
} from '@udemy/contracts';
import { sql } from '@udemy/db';
import type { Enrollment, EnrollmentTransition } from '../domain/enrollment';

/** Narrows a CHECK-constrained text column to its contract union (a mismatch is a bug: 500). */
function narrow<T extends string>(values: readonly T[], value: string, column: string): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${column} value "${value}"`);
}

function narrowNullable<T extends string>(
  values: readonly T[],
  value: string | null,
  column: string,
): T | null {
  return value === null ? null : narrow(values, value, column);
}

/**
 * A timestamptz column (`alias.column`, a trusted identifier) as exact ISO-8601 UTC text WITH
 * microseconds, for keyset cursors (P2 design §14: a JS Date keeps only milliseconds).
 */
export function exactUtcText(columnRef: string) {
  return sql<string>`to_char(${sql.ref(columnRef)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The `enrollment.enrollments` columns every read selects. */
export const ENROLLMENT_COLUMNS = [
  'e.id',
  'e.userId',
  'e.courseId',
  'e.status',
  'e.source',
  'e.orderLineId',
  'e.grantedAt',
  'e.revokedAt',
  'e.revokeReason',
] as const;

export interface EnrollmentRow {
  id: string;
  userId: string;
  courseId: string;
  status: string;
  source: string;
  orderLineId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
}

export function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    userId: row.userId,
    courseId: row.courseId,
    status: narrow(ENROLLMENT_STATUSES, row.status, 'enrollments.status'),
    source: narrow(ENROLLMENT_SOURCES, row.source, 'enrollments.source'),
    orderLineId: row.orderLineId,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    revokeReason: narrowNullable(
      ENROLLMENT_REVOKE_REASONS,
      row.revokeReason,
      'enrollments.revoke_reason',
    ),
  };
}

export interface TransitionRow {
  enrollmentId: string;
  seq: number;
  action: string;
  source: string | null;
  orderLineId: string | null;
  revokeReason: string | null;
  refundId: string | null;
  reason: string | null;
  actorId: string | null;
  occurredAt: Date;
}

export function toTransition(row: TransitionRow): EnrollmentTransition {
  return {
    enrollmentId: row.enrollmentId,
    seq: row.seq,
    action: narrow(ENROLLMENT_TRANSITION_ACTIONS, row.action, 'enrollment_transitions.action'),
    source: narrowNullable(ENROLLMENT_SOURCES, row.source, 'enrollment_transitions.source'),
    orderLineId: row.orderLineId,
    revokeReason: narrowNullable(
      ENROLLMENT_REVOKE_REASONS,
      row.revokeReason,
      'enrollment_transitions.revoke_reason',
    ),
    refundId: row.refundId,
    reason: row.reason,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
  };
}
