import type { TimestampKeyset } from '../learning-cursor';
import type { QuizAttemptStatus } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';

export interface QuizAttemptRecord {
  readonly id: string;
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  /** The live revision at START: grading uses its key (D6). */
  readonly revisionId: string;
  readonly status: QuizAttemptStatus;
  readonly passPct: number;
  readonly questionCount: number;
  readonly correctCount: number | null;
  /** Generated column (the DB is the scoring authority). */
  readonly scorePct: number | null;
  /** Generated column. */
  readonly passed: boolean | null;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly abandonedAt: Date | null;
}

/** One question of an attempt (`quiz_attempt_questions`), attempt order. */
export interface AttemptQuestionRecord {
  readonly questionId: string;
  readonly position: number;
  /** Set once at SUBMIT. */
  readonly isCorrect: boolean | null;
}

/** Keyset of `started_at` (exact SQL text, P2 §14) and the id. */
export type QuizAttemptKeyset = TimestampKeyset;

export interface QuizAttemptPageRow {
  readonly attempt: QuizAttemptRecord;
  readonly keyset: QuizAttemptKeyset;
}

export interface NewQuizAttempt {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly revisionId: string;
  readonly passPct: number;
  /** In display order (position = index). */
  readonly questionIds: readonly string[];
}

export interface AttemptSubmission {
  readonly attemptId: string;
  /** Every question of the attempt with its grade. */
  readonly graded: readonly { readonly questionId: string; readonly isCorrect: boolean }[];
  /** Selected positions per question (answered questions only). */
  readonly selections: ReadonlyMap<string, readonly number[]>;
  readonly correctCount: number;
}

/**
 * `learning.quiz_attempts` and its question/selection rows (schema doc §1, R2/R3):
 *
 * - one IN_PROGRESS attempt per (user, quiz lecture): `quiz_attempts_user_id_lecture_id_open_uq`;
 * - the questions are frozen IN the START transaction (`quiz_attempt_questions_same_tx_ck`);
 * - SUBMIT and abandon are conditional on `status = 'IN_PROGRESS'` (the LearningMaintenanceJob
 *   races a submit: one wins); selections may only be inserted while the attempt is open.
 */
export abstract class QuizAttemptRepository {
  /** The user's open attempt of the lecture, locked FOR UPDATE, or null. */
  abstract lockOpen(
    trx: Transaction<DB>,
    userId: string,
    lectureId: string,
  ): Promise<QuizAttemptRecord | null>;

  /** IN_PROGRESS -> ABANDONED (conditional); false when it was no longer open. */
  abstract abandon(trx: Transaction<DB>, attemptId: string): Promise<boolean>;

  /**
   * Inserts the attempt (`ON CONFLICT` on the open-attempt index `DO NOTHING`) and, when it was
   * inserted, its questions in the same transaction. null = another open attempt won the race
   * (the caller re-reads it: the resume path).
   */
  abstract insert(trx: Transaction<DB>, attempt: NewQuizAttempt): Promise<QuizAttemptRecord | null>;

  /** The user's attempt (IDOR: scoped to the user), optionally locked FOR UPDATE. */
  abstract findOwn(
    userId: string,
    attemptId: string,
    options?: { readonly ex?: Executor; readonly forUpdate?: boolean },
  ): Promise<QuizAttemptRecord | null>;

  abstract listQuestions(attemptId: string, ex?: Executor): Promise<AttemptQuestionRecord[]>;

  /** Selected option positions per question id (ascending). */
  abstract listSelections(attemptId: string, ex?: Executor): Promise<Map<string, number[]>>;

  /**
   * SUBMIT: grades the questions, inserts the selections, then `UPDATE … SET status =
   * 'SUBMITTED' WHERE status = 'IN_PROGRESS'` returning the stored row (generated score and
   * pass). null when the attempt was no longer open (0 rows).
   */
  abstract submit(
    trx: Transaction<DB>,
    submission: AttemptSubmission,
  ): Promise<QuizAttemptRecord | null>;

  /** Keyset `(started_at DESC, id DESC)` of the user's attempts of one lecture. */
  abstract listPage(
    input: {
      readonly userId: string;
      readonly lectureId: string;
      readonly after: QuizAttemptKeyset | null;
      readonly limit: number;
    },
    ex?: Executor,
  ): Promise<QuizAttemptPageRow[]>;

  /** `quiz_attempts.user_id`, or null (ownership resolver). */
  abstract ownerOf(attemptId: string): Promise<string | null>;
}
