import type { DB, Executor, Transaction } from '@udemy/db';
import type {
  Enrollment,
  EnrollmentRevokeReason,
  EnrollmentSource,
  EnrollmentTransition,
  GrantOutcome,
} from '../../domain/enrollment';

export interface GrantEnrollmentCommand {
  readonly userId: string;
  readonly courseId: string;
  readonly source: EnrollmentSource;
  /** Exactly for ORDER. */
  readonly orderLineId: string | null;
  readonly actorId: string | null;
  readonly reason: string | null;
}

export interface RevokeEnrollmentCommand {
  readonly userId: string;
  readonly courseId: string;
  readonly cause: EnrollmentRevokeReason;
  /** Exactly for REFUND. */
  readonly refundId: string | null;
  readonly actorId: string | null;
  readonly reason: string | null;
}

export interface GrantEnrollmentRecord {
  readonly outcome: GrantOutcome;
  /** The row after the grant (unchanged for ALREADY_ACTIVE). */
  readonly enrollment: Enrollment;
}

export interface RevokeEnrollmentRecord {
  readonly outcome: 'REVOKED' | 'ALREADY_REVOKED' | 'NOT_FOUND';
  /** The row after the revoke; null for NOT_FOUND. */
  readonly enrollment: Enrollment | null;
}

/**
 * "My learning" keyset `(granted_at DESC, id DESC)` over ACTIVE rows. `grantedAt` is the exact
 * SQL text (UTC, microseconds): a JS Date would drop the microseconds and skip rows (P2 §14).
 */
export interface MyLearningKeyset {
  readonly grantedAt: string;
  readonly id: string;
}

export interface MyLearningRow {
  readonly enrollment: Enrollment;
  readonly keyset: MyLearningKeyset;
}

/**
 * The `enrollment` tables. Writes take the caller's transaction (grant/revoke are the
 * `@udemy/db` operational SQL: an idempotent upsert / conditional update plus the transition
 * row); reads take an optional executor (default: the root database).
 */
export abstract class EnrollmentRepository {
  abstract grant(
    trx: Transaction<DB>,
    command: GrantEnrollmentCommand,
  ): Promise<GrantEnrollmentRecord>;

  abstract revoke(
    trx: Transaction<DB>,
    command: RevokeEnrollmentCommand,
  ): Promise<RevokeEnrollmentRecord>;

  abstract findById(enrollmentId: string, ex?: Executor): Promise<Enrollment | null>;

  /** The `hasCourseAccess` hot path: one index lookup on `(user_id, course_id) INCLUDE (status)`. */
  abstract hasActive(userId: string, courseId: string, ex?: Executor): Promise<boolean>;

  /** The user's ACTIVE enrollment in the course, or null (the `(user_id, course_id)` unique). */
  abstract findActive(userId: string, courseId: string, ex?: Executor): Promise<Enrollment | null>;

  /** Course ids with an ACTIVE enrollment of the user, among `courseIds` (all when undefined). */
  abstract findActiveCourseIds(
    userId: string,
    courseIds: readonly string[] | undefined,
    ex?: Executor,
  ): Promise<string[]>;

  /** ACTIVE rows, newest grant first, strictly after `after`; at most `limit` rows. */
  abstract listActivePage(
    userId: string,
    after: MyLearningKeyset | null,
    limit: number,
    ex?: Executor,
  ): Promise<MyLearningRow[]>;

  /** Every enrollment of the user (any status), newest grant first. */
  abstract listByUser(userId: string, ex?: Executor): Promise<Enrollment[]>;

  /** The transitions of these enrollments, by enrollment then `seq` (oldest first). */
  abstract listTransitions(
    enrollmentIds: readonly string[],
    ex?: Executor,
  ): Promise<EnrollmentTransition[]>;
}
