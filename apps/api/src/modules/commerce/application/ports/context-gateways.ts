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
}
