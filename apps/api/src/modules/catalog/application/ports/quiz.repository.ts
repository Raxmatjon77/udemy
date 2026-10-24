import type { QuizQuestionKind } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { QuizOptionDraft } from '../../domain/quiz';

/** `lecture_quizzes`: the 1:1 settings row of a QUIZ lecture. */
export interface QuizSettingsRecord {
  readonly lectureId: string;
  readonly passPct: number;
  readonly updatedAt: Date;
}

export interface QuizOptionRecord {
  /** 0-based, contiguous (the options are always replaced as a whole). */
  readonly position: number;
  readonly text: string;
  readonly isCorrect: boolean;
}

export interface QuizQuestionRecord {
  readonly id: string;
  readonly lectureId: string;
  /** 0-based, contiguous within the quiz. */
  readonly position: number;
  readonly kind: QuizQuestionKind;
  readonly promptMd: string;
  readonly explanationMd: string | null;
  readonly updatedAt: Date;
  /** In position order; may be empty while drafting. */
  readonly options: readonly QuizOptionRecord[];
}

/** A QUIZ lecture's working copy: settings and questions in position order. */
export interface WorkingQuizRecord {
  readonly settings: QuizSettingsRecord;
  readonly questions: readonly QuizQuestionRecord[];
}

export interface QuizQuestionPatch {
  readonly kind?: QuizQuestionKind;
  readonly promptMd?: string;
  readonly explanationMd?: string | null;
}

/**
 * The working copy of QUIZ lectures (`lecture_quizzes`, `quiz_questions`, `quiz_options`;
 * Phase 5 schema doc §1c–§1f). Callers resolve the lecture scoped by its course FIRST
 * (`CurriculumRepository.findLecture`), so a lecture id here is always one of the locked
 * course's; question lookups are additionally scoped by the lecture, so a question of another
 * quiz is "not found".
 *
 * Writers run in the caller's transaction, which holds the course row lock (the DB
 * `working_copy_guard` backs the review lock up). Question positions stay contiguous `0..n-1`
 * (the DEFERRED unique lets one statement permute them).
 */
export abstract class QuizRepository {
  /** The quiz of one QUIZ lecture, or null (not a QUIZ lecture). */
  abstract findQuiz(lectureId: string, ex?: Executor): Promise<WorkingQuizRecord | null>;

  /** Every quiz of the course's QUIZ lectures, by lecture id (two queries). */
  abstract listCourseQuizzes(
    courseId: string,
    ex?: Executor,
  ): Promise<Map<string, WorkingQuizRecord>>;

  /** The settings row of a new QUIZ lecture (pass mark default 70), same transaction as it. */
  abstract insertQuiz(trx: Transaction<DB>, lectureId: string): Promise<QuizSettingsRecord>;

  abstract updatePassPct(
    trx: Transaction<DB>,
    lectureId: string,
    passPct: number,
  ): Promise<QuizSettingsRecord>;

  /** Marks the quiz as changed (`updated_at = now()`) after a question write. */
  abstract touch(trx: Transaction<DB>, lectureId: string): Promise<void>;

  /** Question ids in position order. */
  abstract listQuestionIds(trx: Transaction<DB>, lectureId: string): Promise<string[]>;

  /** One question of THIS quiz (with options), or null. */
  abstract findQuestion(
    lectureId: string,
    questionId: string,
    ex?: Executor,
  ): Promise<QuizQuestionRecord | null>;

  /** Appends a question without options at `position`. */
  abstract insertQuestion(
    trx: Transaction<DB>,
    question: {
      readonly lectureId: string;
      readonly position: number;
      readonly kind: QuizQuestionKind;
      readonly promptMd: string;
      readonly explanationMd: string | null;
    },
  ): Promise<QuizQuestionRecord>;

  abstract updateQuestion(
    trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
    patch: QuizQuestionPatch,
  ): Promise<QuizQuestionRecord>;

  /** Deletes the question (its options cascade) and closes the gap. */
  abstract deleteQuestion(
    trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
  ): Promise<void>;

  /** Replaces every option (positions = array order) and bumps the question's `updated_at`. */
  abstract replaceOptions(
    trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
    options: readonly QuizOptionDraft[],
  ): Promise<QuizQuestionRecord>;

  /** Rewrites the positions of a valid reorder (one statement). */
  abstract applyQuestionOrder(
    trx: Transaction<DB>,
    lectureId: string,
    positions: readonly { readonly id: string; readonly position: number }[],
  ): Promise<void>;
}
