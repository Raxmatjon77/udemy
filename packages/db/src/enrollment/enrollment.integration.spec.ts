import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createUser } from '../testing/fixtures';
import { createOrder, createRefund, payOrder } from '../testing/commerce-fixtures';
import { checkDeferredNow, expectFailure, rollback, useIntegrationDb } from '../testing/it-db.mjs';
import {
  findActiveEnrollmentsWithLiveRefund,
  findOrderEnrollmentsWithoutPaidLine,
} from './consistency';
import { grantEnrollment, revokeEnrollment } from './enrollments';

/** enrollment.enrollments + transitions (docs/phase-4-schema-design.md D8, §8.3 step 6, §8.8). Rolled back. */
const pg = useIntegrationDb({ max: 2 });

describe('grantEnrollment / revokeEnrollment', () => {
  it('grant -> already active -> revoke -> already revoked -> regrant, with the log matching at COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const admin = await createUser(trx);
      const course = randomUUID();
      const g = await grantEnrollment(trx, { userId: user, courseId: course, source: 'FREE' });
      expect(g.outcome).toBe('GRANTED');
      expect(
        await grantEnrollment(trx, { userId: user, courseId: course, source: 'FREE' }),
      ).toEqual({
        outcome: 'ALREADY_ACTIVE',
        enrollmentId: g.enrollmentId,
      });
      await checkDeferredNow(trx);
      const reason = 'chargeback on the card';
      expect(
        await revokeEnrollment(trx, {
          userId: user,
          courseId: course,
          revokeReason: 'CHARGEBACK',
          actorId: admin,
          reason,
        }),
      ).toEqual({ outcome: 'REVOKED', enrollmentId: g.enrollmentId });
      expect(
        await revokeEnrollment(trx, {
          userId: user,
          courseId: course,
          revokeReason: 'CHARGEBACK',
          actorId: admin,
          reason,
        }),
      ).toEqual({ outcome: 'ALREADY_REVOKED', enrollmentId: g.enrollmentId });
      expect(
        await revokeEnrollment(trx, {
          userId: user,
          courseId: randomUUID(),
          revokeReason: 'ADMIN',
          actorId: admin,
          reason,
        }),
      ).toEqual({
        outcome: 'NOT_FOUND',
        enrollmentId: null,
      });
      await checkDeferredNow(trx);
      expect(
        await grantEnrollment(trx, {
          userId: user,
          courseId: course,
          source: 'ADMIN',
          actorId: admin,
          reason: 'goodwill re-grant',
        }),
      ).toEqual({ outcome: 'REGRANTED', enrollmentId: g.enrollmentId });
      await checkDeferredNow(trx);
      const { rows } = await sql<{
        seq: number;
        action: string;
        fromStatus: string | null;
        source: string | null;
      }>`
        SELECT seq, action, from_status, source FROM enrollment.enrollment_transitions WHERE enrollment_id = ${g.enrollmentId} ORDER BY seq
      `.execute(trx);
      expect(rows).toEqual([
        { seq: 1, action: 'GRANT', fromStatus: null, source: 'FREE' },
        { seq: 2, action: 'REVOKE', fromStatus: 'ACTIVE', source: null },
        { seq: 3, action: 'REGRANT', fromStatus: 'REVOKED', source: 'ADMIN' },
      ]);
    });
  });

  it('an admin revoke without a reason fails enrollment_transitions_admin_ck; argument shapes fail before SQL', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      await grantEnrollment(trx, { userId: user, courseId: course, source: 'FREE' });
      const err = await expectFailure(trx, () =>
        revokeEnrollment(trx, {
          userId: user,
          courseId: course,
          revokeReason: 'ADMIN',
          actorId: user,
        }),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'enrollment_transitions_admin_ck' });
      await expect(
        grantEnrollment(trx, { userId: user, courseId: course, source: 'ORDER' }),
      ).rejects.toThrow(RangeError);
      await expect(
        revokeEnrollment(trx, { userId: user, courseId: course, revokeReason: 'REFUND' }),
      ).rejects.toThrow(RangeError);
    });
  });

  it('enrollments_status_log_ck: a status change without its transition fails at COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      await grantEnrollment(trx, { userId: user, courseId: course, source: 'FREE' });
      await sql`
        UPDATE enrollment.enrollments SET status = 'REVOKED', revoked_at = now(), revoke_reason = 'ADMIN'
         WHERE user_id = ${user} AND course_id = ${course}
      `.execute(trx);
      return expectFailure(trx, () => checkDeferredNow(trx));
    });
    expect(err).toMatchObject({ code: '23514', constraint: 'enrollments_status_log_ck' });
  });

  it('ORDER grants from a paid order are consistent (§8.8); a refund approval without revoke is reported', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const buyer = await createUser(trx);
      const instructor = await createUser(trx);
      const order = await createOrder(trx, {
        userId: buyer,
        lines: [{ instructorId: instructor, listAmount: '25.00' }],
      });
      const paid = await payOrder(trx, order);
      if (paid.outcome !== 'APPLIED') throw new Error(`unexpected ${paid.outcome}`);
      const line = paid.lines[0]!;
      const g = await grantEnrollment(trx, {
        userId: buyer,
        courseId: line.courseId,
        source: 'ORDER',
        orderLineId: line.id,
      });
      expect(g.outcome).toBe('GRANTED');
      await checkDeferredNow(trx);
      const scope = { userIds: [buyer] };
      expect(await findOrderEnrollmentsWithoutPaidLine(trx, scope)).toEqual([]);
      expect(await findActiveEnrollmentsWithLiveRefund(trx, scope)).toEqual([]);

      const refundId = await createRefund(trx, {
        orderId: order.orderId,
        orderLineId: line.id,
        userId: buyer,
        amount: line.finalAmount,
      });
      expect(await findActiveEnrollmentsWithLiveRefund(trx, scope)).toEqual([g.enrollmentId]);
      expect(
        await revokeEnrollment(trx, {
          userId: buyer,
          courseId: line.courseId,
          revokeReason: 'REFUND',
          refundId,
        }),
      ).toMatchObject({ outcome: 'REVOKED' });
      expect(await findActiveEnrollmentsWithLiveRefund(trx, scope)).toEqual([]);
      await checkDeferredNow(trx);

      // an ORDER grant pointing at a line that is not this user's paid line
      const stray = await grantEnrollment(trx, {
        userId: buyer,
        courseId: randomUUID(),
        source: 'ORDER',
        orderLineId: randomUUID(),
      });
      expect(await findOrderEnrollmentsWithoutPaidLine(trx, scope)).toEqual([stray.enrollmentId]);
    });
  });
});
