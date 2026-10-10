import type {
  EnrollmentRevokeReason,
  EnrollmentSource,
  EnrollmentStatus,
  EnrollmentTransitionAction,
} from '@udemy/contracts';
import { InvalidEnrollmentReason } from './enrollment.errors';

/**
 * Enrollment (commerce & enrollment design §4 "Enrollment", D8, D13, D14). One row per
 * (user, course):
 *
 *   [*] --GRANT (ORDER | FREE | ADMIN)--> ACTIVE --REVOKE (REFUND | ADMIN | CHARGEBACK)--> REVOKED
 *   REVOKED --REGRANT (new purchase, free re-enroll, admin)--> ACTIVE
 *
 * Every edge is one append-only `enrollment_transitions` row; the enrollment columns are its
 * materialisation (checked at COMMIT). Enrollments survive course archive and instructor
 * bans: access ignores the course status (D13).
 */

export type { EnrollmentRevokeReason, EnrollmentSource, EnrollmentStatus };

/** What a grant did: a first grant, a re-grant of a REVOKED row, or nothing (already ACTIVE). */
export type GrantOutcome = 'GRANTED' | 'REGRANTED' | 'ALREADY_ACTIVE';

/** What a revoke did: ACTIVE -> REVOKED, or nothing (no row, or already REVOKED). */
export type RevokeOutcome = 'REVOKED' | 'NOT_ACTIVE';

/** True when the grant changed the enrollment to ACTIVE (and an event must be emitted). */
export function isNewGrant(outcome: GrantOutcome): boolean {
  return outcome !== 'ALREADY_ACTIVE';
}

/** An enrollment row. */
export interface Enrollment {
  readonly id: string;
  readonly userId: string;
  readonly courseId: string;
  readonly status: EnrollmentStatus;
  /** The source of the CURRENT grant. */
  readonly source: EnrollmentSource;
  /** Set exactly when `source` is ORDER (soft ref to commerce.order_lines). */
  readonly orderLineId: string | null;
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
  readonly revokeReason: EnrollmentRevokeReason | null;
}

/** One `enrollment_transitions` row (append-only log, linear by `seq`). */
export interface EnrollmentTransition {
  readonly enrollmentId: string;
  readonly seq: number;
  readonly action: EnrollmentTransitionAction;
  readonly source: EnrollmentSource | null;
  readonly orderLineId: string | null;
  readonly revokeReason: EnrollmentRevokeReason | null;
  readonly refundId: string | null;
  readonly reason: string | null;
  readonly actorId: string | null;
  readonly occurredAt: Date;
}

/** Bounds of an admin reason (`enrollment_transitions_admin_ck` / `_reason_ck`). */
export const ADMIN_REASON_MIN_LENGTH = 10;
export const ADMIN_REASON_MAX_LENGTH = 2000;

/** ADMIN grants and ADMIN / CHARGEBACK revokes are audited: they need an actor and a reason. */
export function requiresAdminAudit(kind: EnrollmentSource | EnrollmentRevokeReason): boolean {
  return kind === 'ADMIN' || kind === 'CHARGEBACK';
}

/**
 * Checks the audit fields of an action before any SQL (the DB CHECK is the backstop).
 *
 * @throws InvalidEnrollmentReason (422 `validation_failed`) when an audited action has no actor
 *   or its reason is not 10–2000 characters
 */
export function assertAuditFields(
  kind: EnrollmentSource | EnrollmentRevokeReason,
  actorId: string | null,
  reason: string | null,
): void {
  if (!requiresAdminAudit(kind)) return;
  const length = reason === null ? 0 : [...reason].length;
  if (
    actorId === null ||
    reason === null ||
    length < ADMIN_REASON_MIN_LENGTH ||
    length > ADMIN_REASON_MAX_LENGTH
  ) {
    throw new InvalidEnrollmentReason();
  }
}
