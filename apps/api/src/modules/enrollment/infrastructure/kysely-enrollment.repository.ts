import { Injectable } from '@nestjs/common';
import {
  type DB,
  type Executor,
  grantEnrollment,
  revokeEnrollment,
  sql,
  type Transaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { Enrollment, EnrollmentTransition } from '../domain/enrollment';
import {
  EnrollmentRepository,
  type GrantEnrollmentCommand,
  type GrantEnrollmentRecord,
  type MyLearningKeyset,
  type MyLearningRow,
  type RevokeEnrollmentCommand,
  type RevokeEnrollmentRecord,
} from '../application/ports/enrollment.repository';
import { mapEnrollmentConstraints } from './enrollment-constraint-errors';
import { ENROLLMENT_COLUMNS, exactUtcText, toEnrollment, toTransition } from './row-mapping';

/**
 * `enrollment.enrollments` / `enrollment_transitions` through Kysely. Grant and revoke are the
 * `@udemy/db` operational SQL (schema doc §8.3 step 6, R4): the idempotent upsert / conditional
 * update plus the transition row with `max(seq) + 1` under the row lock; the row is re-read in
 * the same transaction for the event and the response (timestamps come from SQL `now()`).
 */
@Injectable()
export class KyselyEnrollmentRepository extends EnrollmentRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async grant(
    trx: Transaction<DB>,
    command: GrantEnrollmentCommand,
  ): Promise<GrantEnrollmentRecord> {
    const result = await mapEnrollmentConstraints(() =>
      grantEnrollment(trx, {
        userId: command.userId,
        courseId: command.courseId,
        source: command.source,
        orderLineId: command.orderLineId,
        actorId: command.actorId,
        reason: command.reason,
      }),
    );
    const enrollment = await this.findById(result.enrollmentId, trx);
    if (enrollment === null) throw new Error(`granted enrollment ${result.enrollmentId} vanished`);
    return { outcome: result.outcome, enrollment };
  }

  async revoke(
    trx: Transaction<DB>,
    command: RevokeEnrollmentCommand,
  ): Promise<RevokeEnrollmentRecord> {
    const result = await mapEnrollmentConstraints(() =>
      revokeEnrollment(trx, {
        userId: command.userId,
        courseId: command.courseId,
        revokeReason: command.cause,
        refundId: command.refundId,
        actorId: command.actorId,
        reason: command.reason,
      }),
    );
    const enrollment =
      result.enrollmentId === null ? null : await this.findById(result.enrollmentId, trx);
    return { outcome: result.outcome, enrollment };
  }

  async findById(enrollmentId: string, ex?: Executor): Promise<Enrollment | null> {
    const row = await (ex ?? this.db)
      .selectFrom('enrollment.enrollments as e')
      .select(ENROLLMENT_COLUMNS)
      .where('e.id', '=', enrollmentId)
      .executeTakeFirst();
    return row === undefined ? null : toEnrollment(row);
  }

  async hasActive(userId: string, courseId: string, ex?: Executor): Promise<boolean> {
    const row = await (ex ?? this.db)
      .selectFrom('enrollment.enrollments')
      .select(sql<number>`1`.as('one'))
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return row !== undefined;
  }

  async findActiveCourseIds(
    userId: string,
    courseIds: readonly string[] | undefined,
    ex?: Executor,
  ): Promise<string[]> {
    let query = (ex ?? this.db)
      .selectFrom('enrollment.enrollments')
      .select('courseId')
      .where('userId', '=', userId)
      .where('status', '=', 'ACTIVE');
    if (courseIds !== undefined) {
      if (courseIds.length === 0) return [];
      query = query.where('courseId', 'in', [...courseIds]);
    }
    return (await query.execute()).map((r) => r.courseId);
  }

  async listActivePage(
    userId: string,
    after: MyLearningKeyset | null,
    limit: number,
    ex?: Executor,
  ): Promise<MyLearningRow[]> {
    // Served by enrollments_user_id_granted_at_id_active_idx (user_id, granted_at DESC, id DESC).
    let query = (ex ?? this.db)
      .selectFrom('enrollment.enrollments as e')
      .select(ENROLLMENT_COLUMNS)
      .select(exactUtcText('e.granted_at').as('grantedAtKey'))
      .where('e.userId', '=', userId)
      .where('e.status', '=', 'ACTIVE');
    if (after !== null) {
      query = query.where(
        sql<boolean>`(e.granted_at, e.id) < (${after.grantedAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('e.grantedAt', 'desc')
      .orderBy('e.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      enrollment: toEnrollment(row),
      keyset: { grantedAt: row.grantedAtKey, id: row.id },
    }));
  }

  async listByUser(userId: string, ex?: Executor): Promise<Enrollment[]> {
    const rows = await (ex ?? this.db)
      .selectFrom('enrollment.enrollments as e')
      .select(ENROLLMENT_COLUMNS)
      .where('e.userId', '=', userId)
      .orderBy('e.grantedAt', 'desc')
      .orderBy('e.id', 'desc')
      .execute();
    return rows.map(toEnrollment);
  }

  async listTransitions(
    enrollmentIds: readonly string[],
    ex?: Executor,
  ): Promise<EnrollmentTransition[]> {
    const ids = [...new Set(enrollmentIds)];
    if (ids.length === 0) return [];
    const rows = await (ex ?? this.db)
      .selectFrom('enrollment.enrollmentTransitions')
      .select([
        'enrollmentId',
        'seq',
        'action',
        'source',
        'orderLineId',
        'revokeReason',
        'refundId',
        'reason',
        'actorId',
        'occurredAt',
      ])
      .where('enrollmentId', 'in', ids)
      .orderBy('enrollmentId')
      .orderBy('seq')
      .execute();
    return rows.map(toTransition);
  }
}
