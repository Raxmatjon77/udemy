import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import {
  findActiveEnrollmentsWithLiveRefund,
  findOrderEnrollmentsWithoutPaidLine,
} from './consistency';
import { grantEnrollment, revokeEnrollment } from './enrollments';

const USER = '01900000-0000-7000-8000-0000000000aa';
const COURSE = '01900000-0000-7000-8000-0000000000cc';

describe('grantEnrollment', () => {
  it('GRANTED (old.status NULL) writes a seq-1 GRANT', async () => {
    const s = scriptedDb([{ rows: [{ id: 'e1', previous_status: null }] }, {}]);
    const r = await s.db
      .transaction()
      .execute((trx) => grantEnrollment(trx, { userId: USER, courseId: COURSE, source: 'FREE' }));
    expect(r).toEqual({ outcome: 'GRANTED', enrollmentId: 'e1' });
    expect(s.statements[1]).toContain('ON CONFLICT (user_id, course_id) DO UPDATE');
    expect(s.statements[1]).toContain(
      "WHERE enrollments.status = 'REVOKED' RETURNING id, old.status AS previous_status",
    );
    expect(s.statements[2]).toContain('coalesce(max(seq), 0) + 1');
    expect(s.parameters[2]).toEqual(['e1', 'GRANT', null, 'FREE', null, null, null, 'e1']);
  });

  it('REGRANTED (old.status REVOKED) writes REGRANT from REVOKED', async () => {
    const s = scriptedDb([{ rows: [{ id: 'e1', previous_status: 'REVOKED' }] }, {}]);
    const r = await s.db.transaction().execute((trx) =>
      grantEnrollment(trx, {
        userId: USER,
        courseId: COURSE,
        source: 'ORDER',
        orderLineId: 'l1',
      }),
    );
    expect(r.outcome).toBe('REGRANTED');
    expect(s.parameters[2]).toEqual(['e1', 'REGRANT', 'REVOKED', 'ORDER', 'l1', null, null, 'e1']);
  });

  it('ALREADY_ACTIVE (0 rows) re-reads the id and writes no transition', async () => {
    const s = scriptedDb([{ rows: [] }, { rows: [{ id: 'e1' }] }]);
    const r = await s.db
      .transaction()
      .execute((trx) => grantEnrollment(trx, { userId: USER, courseId: COURSE, source: 'FREE' }));
    expect(r).toEqual({ outcome: 'ALREADY_ACTIVE', enrollmentId: 'e1' });
    expect(s.statements.some((q) => q.includes('enrollment_transitions'))).toBe(false);
  });

  it('validates source / orderLineId and requires a transaction before any SQL', async () => {
    const s = scriptedDb();
    await expect(
      grantEnrollment(s.db, { userId: USER, courseId: COURSE, source: 'FREE' }),
    ).rejects.toThrow(/transaction/);
    await s.db.transaction().execute(async (trx) => {
      await expect(
        grantEnrollment(trx, { userId: USER, courseId: COURSE, source: 'ORDER' }),
      ).rejects.toThrow(RangeError);
      await expect(
        grantEnrollment(trx, { userId: USER, courseId: COURSE, source: 'FREE', orderLineId: 'l' }),
      ).rejects.toThrow(RangeError);
      await expect(
        grantEnrollment(trx, { userId: USER, courseId: COURSE, source: 'GIFT' as 'FREE' }),
      ).rejects.toThrow(RangeError);
    });
    expect(s.statements).toEqual(['BEGIN', 'COMMIT']);
  });
});

describe('revokeEnrollment', () => {
  it('REVOKED writes REVOKE with the refund id', async () => {
    const s = scriptedDb([{ rows: [{ id: 'e1' }] }, {}]);
    const r = await s.db.transaction().execute((trx) =>
      revokeEnrollment(trx, {
        userId: USER,
        courseId: COURSE,
        revokeReason: 'REFUND',
        refundId: 'r1',
      }),
    );
    expect(r).toEqual({ outcome: 'REVOKED', enrollmentId: 'e1' });
    expect(s.statements[1]).toContain("AND status = 'ACTIVE' RETURNING id");
    expect(s.parameters[2]).toEqual(['e1', 'REFUND', 'r1', null, null, 'e1']);
  });

  it('ALREADY_REVOKED / NOT_FOUND are idempotent no-ops', async () => {
    const s = scriptedDb([{ rows: [] }, { rows: [{ id: 'e1' }] }, { rows: [] }, { rows: [] }]);
    await s.db.transaction().execute(async (trx) => {
      const input = {
        userId: USER,
        courseId: COURSE,
        revokeReason: 'ADMIN' as const,
        actorId: USER,
        reason: 'policy violation',
      };
      expect(await revokeEnrollment(trx, input)).toEqual({
        outcome: 'ALREADY_REVOKED',
        enrollmentId: 'e1',
      });
      expect(await revokeEnrollment(trx, input)).toEqual({
        outcome: 'NOT_FOUND',
        enrollmentId: null,
      });
      await expect(revokeEnrollment(trx, { ...input, refundId: 'r' })).rejects.toThrow(RangeError);
    });
    expect(s.statements.some((q) => q.includes('enrollment_transitions'))).toBe(false);
  });
});

describe('consistency (§8.8)', () => {
  it('optionally scoped to users', async () => {
    const s = scriptedDb([{ rows: [{ id: 'e' }] }, { rows: [] }]);
    expect(await findOrderEnrollmentsWithoutPaidLine(s.db)).toEqual(['e']);
    expect(await findActiveEnrollmentsWithLiveRefund(s.db, { userIds: [USER] })).toEqual([]);
    expect(s.statements[0]).not.toContain('ANY(');
    expect(s.statements[1]).toContain('"e"."user_id" = ANY($1::uuid[])');
  });
});
