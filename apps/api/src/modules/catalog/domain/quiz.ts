import {
  isQuizQuestionComplete,
  type LectureType,
  QUIZ_LIMITS,
  type QuizQuestionKind,
} from '@udemy/contracts';
import { LectureTypeMismatch, QuizLimitExceeded, QuizOptionsInvalid } from './catalog.errors';
import { planSiblingOrder } from './curriculum';

export { isQuizQuestionComplete, QUIZ_LIMITS };
export type { QuizQuestionKind };

/*
 * QUIZ lectures (Phase 5 learning experience design D6, §5 catalog). The quiz content is
 * authored in the working copy (`lecture_quizzes`, `quiz_questions`, `quiz_options`), may be
 * incomplete while drafting (readiness `QUIZ_EMPTY` / `QUIZ_QUESTION_INVALID` block the submit)
 * and is snapshotted with the revision, so an answer key is moderated and immutable.
 */

/** One answer option as written (its position is its index, 0-based). */
export interface QuizOptionDraft {
  readonly text: string;
  readonly isCorrect: boolean;
}

/** @throws LectureTypeMismatch (422) unless the lecture is a QUIZ */
export function assertQuizLecture(type: LectureType): void {
  if (type !== 'QUIZ') {
    throw new LectureTypeMismatch('Only quiz lectures have questions.');
  }
}

/** @throws QuizLimitExceeded (422) when the quiz already has `QUIZ_LIMITS.maxQuestions` */
export function assertCanAddQuizQuestion(currentQuestions: number): void {
  if (currentQuestions >= QUIZ_LIMITS.maxQuestions) {
    throw new QuizLimitExceeded(`A quiz can have at most ${QUIZ_LIMITS.maxQuestions} questions.`);
  }
}

/** C0/C1 control characters (`[[:cntrl:]]` of the DB CHECK `quiz_options_text_ck`). */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * The option list of `PutQuizQuestionOptions` (the domain re-check of the request schema):
 * 2–6 options, each 1–300 characters, trimmed, without control characters, and with distinct
 * texts (case-insensitive). The correct-count rule is NOT checked here: a draft may be saved
 * half-done, readiness reports it (`QUIZ_QUESTION_INVALID`).
 *
 * @throws QuizOptionsInvalid (422)
 */
export function assertValidQuizOptions(options: readonly QuizOptionDraft[]): void {
  if (options.length < QUIZ_LIMITS.minOptions || options.length > QUIZ_LIMITS.maxOptions) {
    throw new QuizOptionsInvalid(
      `A question needs ${QUIZ_LIMITS.minOptions} to ${QUIZ_LIMITS.maxOptions} answer options.`,
    );
  }
  const seen = new Set<string>();
  for (const option of options) {
    const length = [...option.text].length;
    if (
      length < 1 ||
      length > 300 ||
      option.text !== option.text.trim() ||
      hasControlCharacter(option.text)
    ) {
      throw new QuizOptionsInvalid(
        'Every option needs 1 to 300 characters of plain text without surrounding spaces.',
      );
    }
    const key = option.text.toLowerCase();
    if (seen.has(key)) throw new QuizOptionsInvalid('Option texts must be distinct.');
    seen.add(key);
  }
}

/**
 * The new question order: exactly a permutation of the current ids (P2 D3).
 *
 * @throws OrderMismatch (409)
 */
export function planQuizQuestionOrder(
  current: readonly string[],
  requested: readonly string[],
): { readonly id: string; readonly position: number }[] {
  return planSiblingOrder(current, requested);
}

/* ----------------------------------------------------------------------------------------
 * The two views of a revision's quiz (D6, Q5). Everything learner-facing goes through
 * `toLearnerQuiz`, which builds NEW objects from an allow-list of fields: no `isCorrect`, no
 * explanation, no correct positions can reach it. `toAnswerKey` is for server-side grading and
 * the post-pass reveal only (learning decides what to reveal; catalog never serves it over a
 * learner route).
 * -------------------------------------------------------------------------------------- */

/** A quiz as a learner sees it before submitting: questions and option texts, NO key. */
export interface LearnerQuiz {
  readonly passPct: number;
  readonly questions: readonly {
    readonly id: string;
    /** 0-based. */
    readonly position: number;
    readonly kind: QuizQuestionKind;
    readonly promptMd: string;
    readonly options: readonly { readonly position: number; readonly text: string }[];
  }[];
}

/** The answer key of a quiz: grading and the reveal after passing only. */
export interface QuizKey {
  readonly passPct: number;
  readonly questions: readonly {
    readonly id: string;
    /** 0-based. */
    readonly position: number;
    readonly kind: QuizQuestionKind;
    /** Positions of the correct options, ascending (SINGLE: exactly one). */
    readonly correct: readonly number[];
    readonly explanationMd: string | null;
  }[];
}

/** Structural input of both views (a revision snapshot quiz). */
export interface QuizContent {
  readonly passPct: number;
  readonly questions: readonly {
    readonly id: string;
    readonly kind: QuizQuestionKind;
    readonly promptMd: string;
    readonly explanationMd: string | null;
    readonly options: readonly { readonly text: string; readonly isCorrect: boolean }[];
  }[];
}

/** The learner view: an allow-list copy, so no key field can ever leak through it. */
export function toLearnerQuiz(quiz: QuizContent): LearnerQuiz {
  return {
    passPct: quiz.passPct,
    questions: quiz.questions.map((question, position) => ({
      id: question.id,
      position,
      kind: question.kind,
      promptMd: question.promptMd,
      options: question.options.map((option, optionPosition) => ({
        position: optionPosition,
        text: option.text,
      })),
    })),
  };
}

/** The answer key (positions of the correct options and the explanation per question). */
export function toQuizKey(quiz: QuizContent): QuizKey {
  return {
    passPct: quiz.passPct,
    questions: quiz.questions.map((question, position) => ({
      id: question.id,
      position,
      kind: question.kind,
      correct: question.options.flatMap((option, optionPosition) =>
        option.isCorrect ? [optionPosition] : [],
      ),
      explanationMd: question.explanationMd,
    })),
  };
}
