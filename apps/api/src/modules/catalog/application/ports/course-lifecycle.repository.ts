import type { CourseStatus, CourseTransitionAction, RevisionKind } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';

/** Head of the course's transition chain (schema doc §6 item 13). */
export interface TransitionHead {
  readonly id: string;
  readonly toStatus: CourseStatus;
}

/**
 * A `catalog.course_transitions` row to append. `prevTransitionId` must be the chain head read
 * under the course row lock (null only for CREATE); `fromStatus` must equal the head's
 * `toStatus`. `occurred_at` is SQL `now()`, so it equals timestamps set in the same transaction.
 */
export interface NewTransition {
  readonly courseId: string;
  readonly prevTransitionId: string | null;
  readonly revisionId: string | null;
  readonly action: CourseTransitionAction;
  readonly fromStatus: CourseStatus | null;
  readonly toStatus: CourseStatus;
  readonly actorId: string;
  readonly reason: string | null;
}

export interface RevisionSummaryRecord {
  readonly id: string;
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  readonly submittedAt: Date;
}

export interface DecisionRecord {
  readonly action: 'APPROVE' | 'REJECT';
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly reason: string | null;
  readonly decidedAt: Date;
}

/**
 * The course lifecycle log (`catalog.course_transitions`) and revision summaries. P2-T9 writes
 * CREATE and DELETE; P2-T10 adds the revision builder and the other actions on top of the same
 * chain helpers.
 */
export abstract class CourseLifecycleRepository {
  /** Chain head; call while holding the course row lock. Null for a course without history. */
  abstract getTransitionHead(
    trx: Transaction<DB>,
    courseId: string,
  ): Promise<TransitionHead | null>;

  /** Appends one transition; returns its id and `occurred_at`. Maps the §9 transition errors. */
  abstract appendTransition(
    trx: Transaction<DB>,
    transition: NewTransition,
  ): Promise<{ id: string; occurredAt: Date }>;

  /** Summaries of the given revisions (pending / live pointers), in no particular order. */
  abstract findRevisionSummaries(
    revisionIds: readonly string[],
    ex?: Executor,
  ): Promise<RevisionSummaryRecord[]>;

  /** The most recent APPROVE or REJECT of the course (highest revision number), if any. */
  abstract findLatestDecision(courseId: string, ex?: Executor): Promise<DecisionRecord | null>;
}
