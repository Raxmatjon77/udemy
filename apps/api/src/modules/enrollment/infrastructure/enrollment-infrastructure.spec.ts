import { describe, expect, it } from 'vitest';
import {
  InvalidEnrollmentReason,
  InvalidStateTransition,
  UserNotFound,
} from '../domain/enrollment.errors';
import {
  mapEnrollmentConstraints,
  rethrowEnrollmentConstraint,
} from './enrollment-constraint-errors';
import { toEnrollment, toTransition } from './row-mapping';

const pg = (code: string, constraint?: string) =>
  Object.assign(new Error(`pg ${code}`), { code, constraint });

describe('enrollment constraint map (schema doc §9)', () => {
  it.each([
    ['enrollment_transitions_pk', '23505', InvalidStateTransition],
    ['enrollment_transitions_edge_ck', '23514', InvalidStateTransition],
    [
      'enrollment_transitions_enrollment_id_prev_seq_from_status_fk',
      '23503',
      InvalidStateTransition,
    ],
    ['enrollment_transitions_admin_ck', '23514', InvalidEnrollmentReason],
    ['enrollment_transitions_reason_ck', '23514', InvalidEnrollmentReason],
    ['enrollments_user_id_fk', '23503', UserNotFound],
  ] as const)('%s -> %s', (constraint, code, error) => {
    const cause = pg(code, constraint);
    expect(() => rethrowEnrollmentConstraint(cause)).toThrow(error);
    try {
      rethrowEnrollmentConstraint(cause);
    } catch (mapped) {
      expect((mapped as Error).cause).toBe(cause);
    }
  });

  it('programming errors stay as they are (500)', async () => {
    for (const error of [
      pg('23514', 'enrollments_status_log_ck'),
      pg('42501', 'enrollments_immutable_ck'),
      pg('23514', 'enrollment_transitions_source_ck'),
      pg('40P01'),
      new Error('boom'),
    ]) {
      await expect(mapEnrollmentConstraints(() => Promise.reject(error))).rejects.toBe(error);
    }
    await expect(mapEnrollmentConstraints(() => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('row mapping', () => {
  const row = {
    id: 'e',
    userId: 'u',
    courseId: 'c',
    status: 'REVOKED',
    source: 'ORDER',
    orderLineId: 'l',
    grantedAt: new Date(0),
    revokedAt: new Date(1),
    revokeReason: 'REFUND',
  };

  it('narrows the CHECK-constrained columns', () => {
    expect(toEnrollment(row)).toMatchObject({
      status: 'REVOKED',
      source: 'ORDER',
      revokeReason: 'REFUND',
    });
    expect(() => toEnrollment({ ...row, status: 'PAUSED' })).toThrow(/enrollments.status/);
    expect(() => toEnrollment({ ...row, revokeReason: 'OOPS' })).toThrow(/revoke_reason/);
    expect(
      toTransition({
        enrollmentId: 'e',
        seq: 2,
        action: 'REVOKE',
        source: null,
        orderLineId: null,
        revokeReason: 'ADMIN',
        refundId: null,
        reason: 'policy violation',
        actorId: 'a',
        occurredAt: new Date(2),
      }),
    ).toMatchObject({ action: 'REVOKE', source: null, revokeReason: 'ADMIN' });
  });
});
