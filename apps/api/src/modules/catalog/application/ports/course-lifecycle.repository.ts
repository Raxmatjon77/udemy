import type { CourseStatus, CourseTransitionAction, RevisionKind } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';

/** Head of the course's transition chain (schema doc §6 item 13). */
export interface TransitionHead {
  readonly id: string;
  readonly toStatus: CourseStatus;
  readonly action: CourseTransitionAction;
  readonly actorId: string;
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
  readonly courseId: string;
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

/** One `course_transitions` row for the history, with its revision number. */
export interface TransitionRecord {
  readonly id: string;
  readonly prevTransitionId: string | null;
  readonly action: CourseTransitionAction;
  readonly fromStatus: CourseStatus | null;
  readonly toStatus: CourseStatus;
  readonly revisionId: string | null;
  readonly revisionNo: number | null;
  readonly actorId: string;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

/** A pending revision in the admin review queue (schema doc §8.5). */
export interface ReviewQueueRecord {
  readonly courseId: string;
  readonly ownerId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  readonly title: string;
  readonly submittedAt: Date;
}

/**
 * The course lifecycle log (`catalog.course_transitions`) and revision summaries. P2-T9 writes
 * CREATE and DELETE; P2-T10 the other actions (revision snapshots live in RevisionRepository).
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

  /** Action of the chain head (the derived badge); null for a course without history. */
  abstract findHeadAction(courseId: string, ex?: Executor): Promise<CourseTransitionAction | null>;

  /** The whole chain, oldest first (walked along `prev_transition_id`, not by clock). */
  abstract listHistory(courseId: string, ex?: Executor): Promise<TransitionRecord[]>;

  /** Pending revisions, oldest first; keyset on the uuidv7 revision id. */
  abstract listReviewQueue(query: {
    readonly limit: number;
    readonly afterRevisionId: string | null;
  }): Promise<ReviewQueueRecord[]>;
}
