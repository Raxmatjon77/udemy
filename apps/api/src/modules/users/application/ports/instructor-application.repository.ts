import type { DB, Executor, Transaction } from '@udemy/db';
import type {
  ApplicationDecision,
  ApplicationStatus,
  ApplicationSubmission,
  InstructorApplicationState,
} from '../../domain/instructor-application';

/** Keyset position of the admin queue: `(submitted_at, id)` of the last row of a page. */
export interface ApplicationKeyset {
  /** `submitted_at` as ISO 8601 with microseconds, e.g. `2026-10-10T09:00:00.123456Z`. */
  readonly submittedAt: string;
  readonly id: string;
}

export interface ApplicationQueueFilter {
  readonly status: ApplicationStatus;
  readonly after?: ApplicationKeyset;
  /** Rows to fetch (the caller asks for limit + 1 to detect a next page). */
  readonly take: number;
}

export interface ApplicationQueueRow {
  readonly application: InstructorApplicationState;
  readonly keyset: ApplicationKeyset;
}

/** Result of the conditional state update. */
export type ApplyDecisionResult =
  | { readonly applied: true; readonly version: number }
  | {
      readonly applied: false;
    };

/**
 * Port for `users.instructor_applications` + `users.instructor_application_transitions`.
 * Every read returns the transitions too (oldest first), loaded in one extra query per call,
 * never per application. Constraint violations surface as domain errors
 * (ApplicationAlreadyPending, InvalidStateTransition, SelfDecisionForbidden, UserNotFound).
 */
export abstract class InstructorApplicationRepository {
  abstract findById(id: string, ex?: Executor): Promise<InstructorApplicationState | null>;

  /** Ownership lookup for `@CheckPolicy`: the applicant id, or null when unknown. */
  abstract findApplicantId(id: string, ex?: Executor): Promise<string | null>;

  abstract hasPending(applicantId: string, ex?: Executor): Promise<boolean>;

  /** The applicant's applications, newest first. */
  abstract listByApplicant(
    applicantId: string,
    ex?: Executor,
  ): Promise<InstructorApplicationState[]>;

  /** Admin queue: `WHERE status = $1 ORDER BY submitted_at, id` (oldest first), keyset. */
  abstract listByStatus(
    filter: ApplicationQueueFilter,
    ex?: Executor,
  ): Promise<ApplicationQueueRow[]>;

  /**
   * Inserts the application and its submission transition (`from_status` NULL).
   * @throws ApplicationAlreadyPending (partial unique index), UserNotFound (FK)
   */
  abstract insert(trx: Transaction<DB>, submission: ApplicationSubmission): Promise<{ id: string }>;

  /**
   * `UPDATE ... SET status = $to, version = version + 1 WHERE id = $id AND status = 'PENDING'
   * [AND version = $expectedVersion]`. Holds the row lock until commit, so a concurrent
   * decision waits and then re-evaluates the WHERE (and matches nothing).
   */
  abstract applyDecision(
    trx: Transaction<DB>,
    decision: ApplicationDecision,
    expectedVersion: number | undefined,
  ): Promise<ApplyDecisionResult>;

  /**
   * Appends the decision's transition row; returns its SQL `now()`.
   * @throws InvalidStateTransition (`ia_transitions_*_uq`, edge CHECK),
   *   SelfDecisionForbidden (`ia_transitions_actor_ck`)
   */
  abstract insertTransition(
    trx: Transaction<DB>,
    decision: ApplicationDecision,
  ): Promise<{ occurredAt: Date }>;
}
