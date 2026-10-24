import type { InstructorQaStatus, QaSort } from '@udemy/contracts';
import type { DB, Executor, QuestionCursor, Transaction, VoteSubject } from '@udemy/db';
import type { AnswerRecord, QuestionRecord } from '../../domain/qa';

/** Keyset of the answers page (oldest first) and the instructor inbox (newest first). */
export interface CreatedAtKeyset {
  /** `created_at` exactly as SQL printed it (UTC, microseconds). */
  readonly createdAt: string;
  readonly id: string;
}

export interface QuestionListOptions {
  readonly courseId: string;
  readonly sort: QaSort;
  readonly lectureId?: string | undefined;
  /** Title search (>= `QA_LIMITS.searchMinChars`, trimmed). */
  readonly titleContains?: string | undefined;
  readonly after: QuestionCursor | null;
  readonly limit: number;
}

export interface QuestionListRow {
  readonly question: QuestionRecord;
  /** The next-page cursor of this row for the requested sort (exact SQL text). */
  readonly cursor: QuestionCursor;
}

export interface CreatedAtRow<T> {
  readonly record: T;
  readonly createdAtKey: string;
}

export interface InboxOptions {
  /** The owner's live courses (at most `OWNED_LIVE_COURSES_MAX`). */
  readonly courseIds: readonly string[];
  readonly status: InstructorQaStatus;
  readonly after: CreatedAtKeyset | null;
  readonly limit: number;
}

/** An answer and its question (answers are resolved within the route's course). */
export interface AnswerWithQuestion {
  readonly answer: AnswerRecord;
  readonly question: QuestionRecord;
}

export interface AcceptedAnswerChange {
  readonly question: QuestionRecord;
  /** The accepted answer before the update (null = was OPEN). */
  readonly previousAnswerId: string | null;
  /** The transaction's `now()` (the event timestamp). */
  readonly at: Date;
}

/**
 * `engagement.questions` / `answers` / `*_votes` (D12). The counters are trigger-maintained:
 * nothing here writes `upvote_count`, `answer_count` or `last_activity_at`. Writes take the
 * caller's transaction (READ COMMITTED); timestamps come from SQL `now()`.
 *
 * Lock order (deadlock freedom with the `answers_sync_question` trigger and `@udemy/db`
 * moderation, which lock the answer, then its question): answer row -> question row.
 */
export abstract class QaRepository {
  /** Visible, non-deleted questions of a course (`@udemy/db` `listQuestions`, keyset per sort). */
  abstract listQuestions(options: QuestionListOptions): Promise<QuestionListRow[]>;

  /**
   * A question in any state. Callers scope it to the route's course (`courseId` mismatch = 404,
   * IDOR) and apply the visibility rules of `domain/qa`.
   */
  abstract findQuestion(questionId: string, ex?: Executor): Promise<QuestionRecord | null>;

  /** As `findQuestion`, locking the row (`FOR NO KEY UPDATE`) for the transaction. */
  abstract lockQuestion(trx: Transaction<DB>, questionId: string): Promise<QuestionRecord | null>;

  abstract insertQuestion(
    trx: Transaction<DB>,
    input: {
      courseId: string;
      lectureId: string | null;
      authorId: string;
      title: string;
      bodyMd: string;
    },
  ): Promise<QuestionRecord>;

  /** Edits a non-deleted question; `edited_at` only moves when something changed. */
  abstract updateQuestion(
    trx: Transaction<DB>,
    questionId: string,
    changes: { title?: string | undefined; bodyMd?: string | undefined },
  ): Promise<QuestionRecord | null>;

  /** Soft delete; null when already deleted. */
  abstract softDeleteQuestion(
    trx: Transaction<DB>,
    questionId: string,
  ): Promise<QuestionRecord | null>;

  /**
   * Sets (or clears, `answerId` null) the accepted answer of a non-deleted question. The DB
   * guards that the answer is a visible answer of this question (composite FK + trigger).
   * Null when the question is deleted.
   */
  abstract setAcceptedAnswer(
    trx: Transaction<DB>,
    questionId: string,
    answerId: string | null,
  ): Promise<AcceptedAnswerChange | null>;

  /** Answers the viewer can see (not deleted; VISIBLE or their own), oldest first. */
  abstract listAnswers(
    questionId: string,
    viewerId: string,
    after: CreatedAtKeyset | null,
    limit: number,
  ): Promise<CreatedAtRow<AnswerRecord>[]>;

  /** An answer (any state) with its question; callers scope it to the route's course. */
  abstract findAnswer(answerId: string, ex?: Executor): Promise<AnswerWithQuestion | null>;

  /**
   * Locks the answer, then its question (`FOR NO KEY UPDATE`), and tells whether it is the
   * accepted answer right now. Null when the answer does not exist.
   */
  abstract lockAnswerAcceptance(
    trx: Transaction<DB>,
    answerId: string,
  ): Promise<{ readonly wasAccepted: boolean } | null>;

  abstract insertAnswer(
    trx: Transaction<DB>,
    input: { questionId: string; authorId: string; bodyMd: string },
  ): Promise<AnswerRecord>;

  /** Edits a non-deleted answer; `edited_at` only moves when the body changed. */
  abstract updateAnswer(
    trx: Transaction<DB>,
    answerId: string,
    bodyMd: string,
  ): Promise<AnswerRecord | null>;

  /** Soft delete (the trigger recounts and clears the accepted answer); null when deleted. */
  abstract softDeleteAnswer(trx: Transaction<DB>, answerId: string): Promise<AnswerRecord | null>;

  /** Upvote (idempotent): true when this call added it. Own content / unknown subject throw. */
  abstract castVote(subject: VoteSubject, subjectId: string, userId: string): Promise<boolean>;

  /** Remove an upvote (idempotent): true when this call removed it. */
  abstract retractVote(subject: VoteSubject, subjectId: string, userId: string): Promise<boolean>;

  /** The subjects among `subjectIds` the user has upvoted. */
  abstract votedAmong(
    subject: VoteSubject,
    subjectIds: readonly string[],
    userId: string,
  ): Promise<ReadonlySet<string>>;

  /** Visible, non-deleted questions of the owner's courses, newest first (`created_at`). */
  abstract listInbox(options: InboxOptions): Promise<CreatedAtRow<QuestionRecord>[]>;
}
