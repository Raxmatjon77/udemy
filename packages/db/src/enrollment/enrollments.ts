/**
 * Enrollment grant / revoke (docs/phase-4-schema-design.md D8, §8.3 step 6, R4), for
 * EnrollmentFacade (T12). Both are idempotent and run in the caller's transaction (the PAID
 * transition, free enroll, admin actions, refund approval). Several grants in one transaction:
 * call them in ascending course_id (lock order).
 *
 * The upsert `ON CONFLICT (user_id, course_id) DO UPDATE ... WHERE status = 'REVOKED'` locks the
 * existing row even when the WHERE is false, so concurrent grants serialise: exactly one side
 * GRANTs/REGRANTs and the other sees ALREADY_ACTIVE. `RETURNING old.status` (PG 18) is NULL for an
 * insert. Columns must equal the transition log at COMMIT (enrollments_status_log_ck).
 */
import { sql } from 'kysely';
import { assertOneOf } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';

export type EnrollmentSource = 'ORDER' | 'FREE' | 'ADMIN';
export type RevokeReason = 'REFUND' | 'ADMIN' | 'CHARGEBACK';

export interface GrantEnrollmentInput {
  userId: string;
  courseId: string;
  source: EnrollmentSource;
  /** Required iff source = ORDER (soft ref to commerce.order_lines). */
  orderLineId?: string | null;
  /** ADMIN: required, with a reason of >= 10 characters (enrollment_transitions_admin_ck). */
  actorId?: string | null;
  reason?: string | null;
}

export type GrantOutcome = 'GRANTED' | 'REGRANTED' | 'ALREADY_ACTIVE';

export interface GrantEnrollmentResult {
  outcome: GrantOutcome;
  enrollmentId: string;
}

export async function grantEnrollment(
  executor: Executor,
  input: GrantEnrollmentInput,
): Promise<GrantEnrollmentResult> {
  const trx = requireTransaction(executor, 'grantEnrollment');
  assertOneOf('source', input.source, ['ORDER', 'FREE', 'ADMIN']);
  const orderLineId = input.orderLineId ?? null;
  if ((input.source === 'ORDER') !== (orderLineId !== null)) {
    throw new RangeError('orderLineId is required for source ORDER and forbidden otherwise');
  }
  const { rows } = await sql<{ id: string; previousStatus: string | null }>`
    INSERT INTO enrollment.enrollments (user_id, course_id, source, order_line_id)
    VALUES (${input.userId}, ${input.courseId}, ${input.source}, ${orderLineId})
    ON CONFLICT (user_id, course_id) DO UPDATE
       SET status = 'ACTIVE', source = EXCLUDED.source, order_line_id = EXCLUDED.order_line_id,
           granted_at = now(), revoked_at = NULL, revoke_reason = NULL
     WHERE enrollments.status = 'REVOKED'
    RETURNING id, old.status AS previous_status
  `.execute(trx);
  const row = rows[0];
  if (row === undefined) {
    const { rows: existing } = await sql<{ id: string }>`
      SELECT id FROM enrollment.enrollments WHERE user_id = ${input.userId} AND course_id = ${input.courseId}
    `.execute(trx);
    return { outcome: 'ALREADY_ACTIVE', enrollmentId: existing[0]!.id };
  }
  const regrant = row.previousStatus === 'REVOKED';
  await sql`
    INSERT INTO enrollment.enrollment_transitions
      (enrollment_id, seq, action, from_status, to_status, source, order_line_id, actor_id, reason)
    SELECT ${row.id}, coalesce(max(seq), 0) + 1, ${regrant ? 'REGRANT' : 'GRANT'},
           ${regrant ? 'REVOKED' : null}, 'ACTIVE', ${input.source}, ${orderLineId},
           ${input.actorId ?? null}, ${input.reason ?? null}
      FROM enrollment.enrollment_transitions WHERE enrollment_id = ${row.id}
  `.execute(trx);
  return { outcome: regrant ? 'REGRANTED' : 'GRANTED', enrollmentId: row.id };
}

export interface RevokeEnrollmentInput {
  userId: string;
  courseId: string;
  revokeReason: RevokeReason;
  /** Required iff revokeReason = REFUND (soft ref to commerce.refunds). */
  refundId?: string | null;
  /** ADMIN / CHARGEBACK: required, with a reason of >= 10 characters. */
  actorId?: string | null;
  reason?: string | null;
}

export type RevokeOutcome = 'REVOKED' | 'ALREADY_REVOKED' | 'NOT_FOUND';

export interface RevokeEnrollmentResult {
  outcome: RevokeOutcome;
  enrollmentId: string | null;
}

export async function revokeEnrollment(
  executor: Executor,
  input: RevokeEnrollmentInput,
): Promise<RevokeEnrollmentResult> {
  const trx = requireTransaction(executor, 'revokeEnrollment');
  assertOneOf('revokeReason', input.revokeReason, ['REFUND', 'ADMIN', 'CHARGEBACK']);
  const refundId = input.refundId ?? null;
  if ((input.revokeReason === 'REFUND') !== (refundId !== null)) {
    throw new RangeError('refundId is required for revokeReason REFUND and forbidden otherwise');
  }
  const { rows } = await sql<{ id: string }>`
    UPDATE enrollment.enrollments
       SET status = 'REVOKED', revoked_at = now(), revoke_reason = ${input.revokeReason}
     WHERE user_id = ${input.userId} AND course_id = ${input.courseId} AND status = 'ACTIVE'
    RETURNING id
  `.execute(trx);
  const row = rows[0];
  if (row === undefined) {
    const { rows: existing } = await sql<{ id: string }>`
      SELECT id FROM enrollment.enrollments WHERE user_id = ${input.userId} AND course_id = ${input.courseId}
    `.execute(trx);
    const id = existing[0]?.id ?? null;
    return { outcome: id === null ? 'NOT_FOUND' : 'ALREADY_REVOKED', enrollmentId: id };
  }
  await sql`
    INSERT INTO enrollment.enrollment_transitions
      (enrollment_id, seq, action, from_status, to_status, revoke_reason, refund_id, actor_id, reason)
    SELECT ${row.id}, max(seq) + 1, 'REVOKE', 'ACTIVE', 'REVOKED', ${input.revokeReason}, ${refundId},
           ${input.actorId ?? null}, ${input.reason ?? null}
      FROM enrollment.enrollment_transitions WHERE enrollment_id = ${row.id}
  `.execute(trx);
  return { outcome: 'REVOKED', enrollmentId: row.id };
}
