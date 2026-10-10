import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import {
  assertAuditFields,
  type Enrollment,
  type EnrollmentRevokeReason,
  type EnrollmentSource,
  type GrantOutcome,
  isNewGrant,
  type RevokeOutcome,
} from '../domain/enrollment';
import { EnrollmentEventPublisher } from './ports/enrollment-event.publisher';
import { EnrollmentRepository } from './ports/enrollment.repository';

export interface GrantInput {
  readonly userId: string;
  readonly courseId: string;
  readonly source: EnrollmentSource;
  /** Required exactly for ORDER (the paid order line). */
  readonly orderLineId?: string | null;
  /** Required for ADMIN (with `reason`, 10–2000 characters). */
  readonly actorId?: string | null;
  readonly reason?: string | null;
}

export interface RevokeInput {
  readonly userId: string;
  readonly courseId: string;
  readonly cause: EnrollmentRevokeReason;
  /** Required exactly for REFUND. */
  readonly refundId?: string | null;
  /** Required for ADMIN and CHARGEBACK (with `reason`, 10–2000 characters). */
  readonly actorId?: string | null;
  readonly reason?: string | null;
}

export interface GrantResult {
  readonly outcome: GrantOutcome;
  readonly enrollment: Enrollment;
}

export interface RevokeResult {
  readonly outcome: RevokeOutcome;
  /** Null when the user was never enrolled in the course. */
  readonly enrollment: Enrollment | null;
}

/**
 * The one write path for enrollments (design §3, D8), shared by `EnrollmentFacade` (commerce:
 * PAID transition, refund approval) and the enrollment use cases (free enroll, admin). Runs in
 * the CALLER's transaction: the row, its transition and the outbox event commit together.
 *
 * Idempotent: a grant of an ACTIVE enrollment and a revoke of a non-ACTIVE one change nothing
 * and emit nothing. Concurrent grants serialise on the upsert's row lock (schema doc R4).
 */
@Injectable()
export class EnrollmentWriter {
  constructor(
    private readonly enrollments: EnrollmentRepository,
    private readonly events: EnrollmentEventPublisher,
  ) {}

  /**
   * @throws InvalidEnrollmentReason (422) for an ADMIN grant without an actor or a valid reason
   * @throws RangeError (a caller bug) for ORDER without `orderLineId`, or one given otherwise
   */
  async grant(trx: Transaction<DB>, input: GrantInput): Promise<GrantResult> {
    const actorId = input.actorId ?? null;
    const reason = input.reason ?? null;
    assertAuditFields(input.source, actorId, reason);
    const { outcome, enrollment } = await this.enrollments.grant(trx, {
      userId: input.userId,
      courseId: input.courseId,
      source: input.source,
      orderLineId: input.orderLineId ?? null,
      actorId,
      reason,
    });
    if (isNewGrant(outcome)) {
      await this.events.granted(trx, {
        enrollmentId: enrollment.id,
        userId: enrollment.userId,
        courseId: enrollment.courseId,
        source: enrollment.source,
        orderLineId: enrollment.orderLineId,
        regrant: outcome === 'REGRANTED',
        grantedAt: enrollment.grantedAt.toISOString(),
      });
    }
    return { outcome, enrollment };
  }

  /**
   * @throws InvalidEnrollmentReason (422) for an ADMIN / CHARGEBACK revoke without an actor or
   *   a valid reason
   * @throws RangeError (a caller bug) for REFUND without `refundId`, or one given otherwise
   */
  async revoke(trx: Transaction<DB>, input: RevokeInput): Promise<RevokeResult> {
    const actorId = input.actorId ?? null;
    const reason = input.reason ?? null;
    assertAuditFields(input.cause, actorId, reason);
    const result = await this.enrollments.revoke(trx, {
      userId: input.userId,
      courseId: input.courseId,
      cause: input.cause,
      refundId: input.refundId ?? null,
      actorId,
      reason,
    });
    if (result.outcome !== 'REVOKED' || result.enrollment === null) {
      return { outcome: 'NOT_ACTIVE', enrollment: result.enrollment };
    }
    const enrollment = result.enrollment;
    if (enrollment.revokedAt === null) {
      throw new Error(`enrollment ${enrollment.id} was revoked without revoked_at`);
    }
    await this.events.revoked(trx, {
      enrollmentId: enrollment.id,
      userId: enrollment.userId,
      courseId: enrollment.courseId,
      reason: input.cause,
      refundId: input.refundId ?? null,
      actorId,
      revokedAt: enrollment.revokedAt.toISOString(),
    });
    return { outcome: 'REVOKED', enrollment };
  }
}
