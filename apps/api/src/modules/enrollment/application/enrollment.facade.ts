import { Injectable } from '@nestjs/common';
import type { DB, Executor, Transaction } from '@udemy/db';
import type {
  EnrollmentRevokeReason,
  EnrollmentSource,
  GrantOutcome,
  RevokeOutcome,
} from '../domain/enrollment';
import { isUuid } from './ids';
import { EnrollmentRepository } from './ports/enrollment.repository';
import { EnrollmentWriter } from './enrollment-writer';

export interface GrantEnrollmentInput {
  readonly userId: string;
  readonly courseId: string;
  /** ORDER (the PAID transition), FREE (D14) or ADMIN (support, with actor and reason). */
  readonly source: EnrollmentSource;
  /** Required exactly for ORDER: the paid order line (soft ref). */
  readonly orderLineId?: string | null;
  /** Required for ADMIN; recorded on the transition otherwise when given. */
  readonly actorId?: string | null;
  /** Required for ADMIN (10–2000 characters). */
  readonly reason?: string | null;
}

export interface GrantEnrollmentResult {
  readonly enrollmentId: string;
  readonly outcome: GrantOutcome;
  /**
   * True when THIS call made the enrollment ACTIVE (GRANTED or REGRANTED) and wrote
   * `EnrollmentGranted`. False for ALREADY_ACTIVE: commerce turns that into a
   * `DUPLICATE_PURCHASE` refund (D15).
   */
  readonly newlyGranted: boolean;
}

export interface RevokeEnrollmentInput {
  readonly userId: string;
  readonly courseId: string;
  /** REFUND (refund approval, with `refundId`), ADMIN or CHARGEBACK (with actor and reason). */
  readonly cause: EnrollmentRevokeReason;
  /** Required exactly for REFUND (soft ref to commerce.refunds). */
  readonly refundId?: string | null;
  readonly actorId?: string | null;
  readonly reason?: string | null;
}

export interface RevokeEnrollmentResult {
  /** Null when the user was never enrolled in the course. */
  readonly enrollmentId: string | null;
  /** NOT_ACTIVE: nothing to revoke (never enrolled, or already REVOKED); no event. */
  readonly outcome: RevokeOutcome;
}

/** `findActiveGrant`: what granted the user's current ACTIVE enrollment. */
export interface ActiveEnrollmentGrant {
  readonly enrollmentId: string;
  readonly source: EnrollmentSource;
  /** Set exactly for ORDER: the paid order line that granted it. */
  readonly orderLineId: string | null;
}

/**
 * Public facade of the enrollment context (commerce & enrollment design §3). Write methods take
 * the CALLER's transaction first (P1 convention): commerce grants inside the order PAID
 * transition and revokes inside the refund approval (D8), so "paid <=> enrolled" is atomic.
 * `EnrollmentGranted` / `EnrollmentRevoked` go to the outbox in that same transaction.
 * Reads take an optional executor.
 *
 * Lock order (schema doc R8): enrollments are locked LAST; several grants in one transaction
 * must run in ascending `courseId`.
 */
@Injectable()
export class EnrollmentFacade {
  constructor(
    private readonly writer: EnrollmentWriter,
    private readonly enrollments: EnrollmentRepository,
  ) {}

  /**
   * Idempotent grant: `INSERT ... ON CONFLICT (user_id, course_id) DO UPDATE ... WHERE
   * status = 'REVOKED'`. GRANTED / REGRANTED write a transition and `EnrollmentGranted`;
   * ALREADY_ACTIVE writes nothing.
   *
   * @throws InvalidEnrollmentReason (422) for ADMIN without an actor or a valid reason
   * @throws RangeError (a caller bug) for an `orderLineId` mismatch or a non-transaction
   */
  async grant(trx: Transaction<DB>, input: GrantEnrollmentInput): Promise<GrantEnrollmentResult> {
    const { outcome, enrollment } = await this.writer.grant(trx, input);
    return {
      enrollmentId: enrollment.id,
      outcome,
      newlyGranted: outcome !== 'ALREADY_ACTIVE',
    };
  }

  /**
   * Idempotent revoke: ACTIVE -> REVOKED with a transition and `EnrollmentRevoked`; anything
   * else is NOT_ACTIVE and writes nothing.
   *
   * @throws InvalidEnrollmentReason (422) for ADMIN / CHARGEBACK without an actor or a reason
   * @throws RangeError (a caller bug) for a `refundId` mismatch or a non-transaction
   */
  async revoke(
    trx: Transaction<DB>,
    input: RevokeEnrollmentInput,
  ): Promise<RevokeEnrollmentResult> {
    const { outcome, enrollment } = await this.writer.revoke(trx, input);
    return { enrollmentId: enrollment?.id ?? null, outcome };
  }

  /**
   * The courses among `courseIds` (every course when omitted) in which the user has an ACTIVE
   * enrollment. Malformed ids are never active.
   */
  async activeCourseIds(
    userId: string,
    courseIds?: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlySet<string>> {
    if (!isUuid(userId)) return new Set();
    const ids = courseIds === undefined ? undefined : [...new Set(courseIds)].filter(isUuid);
    if (ids !== undefined && ids.length === 0) return new Set();
    return new Set(await this.enrollments.findActiveCourseIds(userId, ids, ex));
  }

  /**
   * The user's ACTIVE grant of the course: which source and which paid order line granted it
   * (commerce revokes on a refund only the access that the refunded line granted). Null when
   * not actively enrolled or for malformed ids.
   */
  async findActiveGrant(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<ActiveEnrollmentGrant | null> {
    if (!isUuid(userId) || !isUuid(courseId)) return null;
    const enrollment = await this.enrollments.findActive(userId, courseId, ex);
    return enrollment === null
      ? null
      : {
          enrollmentId: enrollment.id,
          source: enrollment.source,
          orderLineId: enrollment.orderLineId,
        };
  }

  /** True when the user has an ACTIVE enrollment in the course (whatever the course status, D13). */
  hasAccess(userId: string, courseId: string, ex?: Executor): Promise<boolean> {
    if (!isUuid(userId) || !isUuid(courseId)) return Promise.resolve(false);
    return this.enrollments.hasActive(userId, courseId, ex);
  }
}
