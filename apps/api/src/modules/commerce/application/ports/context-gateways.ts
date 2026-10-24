import type { AccountStatus } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { QuoteCourse } from '../../domain/quote';

/*
 * What commerce needs from the other contexts, as commerce-side ports (design §1, §3). The
 * adapters (`facade-gateways.ts`) delegate to the module facades; use cases depend only on
 * these, so they unit-test with fakes and never see another module's providers.
 */

/** Catalog: live course summaries (`CatalogFacade.getCourseSummaries`, at most 100 ids). */
export abstract class CommerceCatalog {
  /** PUBLISHED or ARCHIVED courses among `courseIds`; unknown/deleted ids are omitted. */
  abstract getCourses(courseIds: readonly string[], ex?: Executor): Promise<QuoteCourse[]>;
}

/** A person as shown on a cart line (`PersonRef`); banned users are hidden (null). */
export interface CommercePerson {
  readonly displayName: string;
  readonly banned: boolean;
}

/** Identity: display names and ban state (`IdentityFacade.getUserSummaries`). */
export abstract class CommercePeople {
  abstract findPeople(
    userIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlyMap<string, CommercePerson>>;
}

/** The buyer as checkout needs it (`IdentityFacade.getUserSummary`). */
export interface CommerceBuyer {
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
}

/** Identity: the buyer's verified state (D17) and the email Stripe prefills. */
export abstract class CommerceBuyers {
  /** null = no such user. */
  abstract findBuyer(userId: string, ex?: Executor): Promise<CommerceBuyer | null>;
}

export type CommerceEnrollmentSource = 'ORDER' | 'FREE' | 'ADMIN';
export type CommerceRevokeCause = 'REFUND' | 'ADMIN' | 'CHARGEBACK';

export interface CommerceGrantInput {
  readonly userId: string;
  readonly courseId: string;
  readonly source: CommerceEnrollmentSource;
  /** Required exactly for ORDER. */
  readonly orderLineId?: string | null;
  readonly actorId?: string | null;
  readonly reason?: string | null;
}

export interface CommerceGrantResult {
  readonly enrollmentId: string;
  readonly outcome: 'GRANTED' | 'REGRANTED' | 'ALREADY_ACTIVE';
  /** false for ALREADY_ACTIVE: the PAID path turns that into a DUPLICATE_PURCHASE refund (D15). */
  readonly newlyGranted: boolean;
}

export interface CommerceRevokeInput {
  readonly userId: string;
  readonly courseId: string;
  readonly cause: CommerceRevokeCause;
  /** Required exactly for REFUND. */
  readonly refundId?: string | null;
  readonly actorId?: string | null;
  readonly reason?: string | null;
}

/** What granted a user's ACTIVE enrollment (`EnrollmentFacade.findActiveGrant`). */
export interface CommerceActiveGrant {
  readonly enrollmentId: string;
  readonly source: CommerceEnrollmentSource;
  /** Set exactly for ORDER. */
  readonly orderLineId: string | null;
}

export interface CommerceRevokeResult {
  readonly enrollmentId: string | null;
  readonly outcome: 'REVOKED' | 'NOT_ACTIVE';
}

/**
 * Enrollment (`EnrollmentFacade`, design §3). T13 reads `activeCourseIds` (cart eligibility,
 * purchase states); `grant` / `revoke` are the P4-T15/T16 seams (the PAID transition and the
 * refund approval), always on the CALLER's transaction and locked last (schema doc R8).
 */
export abstract class CommerceEnrollments {
  abstract activeCourseIds(
    userId: string,
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlySet<string>>;

  abstract grant(trx: Transaction<DB>, input: CommerceGrantInput): Promise<CommerceGrantResult>;

  abstract revoke(trx: Transaction<DB>, input: CommerceRevokeInput): Promise<CommerceRevokeResult>;

  /** The user's ACTIVE grant of the course, or null (refund approval reads it, P4-T16). */
  abstract findActiveGrant(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<CommerceActiveGrant | null>;
}

/** An account as admin views show it (email and ban state included; admin app only). */
export interface CommerceAccount {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly status: AccountStatus;
}

/** Identity for the admin order and refund views (P4-T16). */
export abstract class CommerceAdminDirectory {
  /** The existing accounts among `userIds` (unknown ids are omitted). */
  abstract findAccounts(
    userIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlyMap<string, CommerceAccount>>;

  /**
   * Ids of up to `limit` accounts whose email contains `fragment` (case-insensitive, at least
   * 3 characters), the most recently created first.
   */
  abstract searchIdsByEmail(fragment: string, limit: number): Promise<string[]>;
}

/** What a learner consumed of a course (`LearningFacade.getConsumption`, Phase 5 D8). */
export interface CommerceConsumption {
  readonly videoSecondsWatched: number;
  readonly videoSecondsTotal: number;
  readonly completedLectures: number;
  readonly totalLectures: number;
  readonly courseCompletedAt: Date | null;
  readonly certificateStatus: 'ACTIVE' | 'REVOKED' | null;
}

/**
 * Learning (`LearningFacade`, Phase 5 design §3, D8): the consumption figures behind the refund
 * review rule and the refund views. Reads only and takes no locks, so it may run inside the
 * refund transaction after the cart and order locks (schema doc R8).
 */
export abstract class CommerceLearning {
  abstract getConsumption(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<CommerceConsumption>;
}
