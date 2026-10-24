import type { QuizQuestionKind, QuizQuestionResult, QuizResult } from '@udemy/contracts';
import { QuizAnswersInvalid } from './learning.errors';

/*
 * Quiz grading and the reveal policy (design D6, §4 QuizAttempt, Q5 / decision P5-D5).
 *
 * - A question is correct iff the selected set equals the correct set; unanswered is wrong.
 * - score = round(correct / total × 100) (half away from zero, like the generated column
 *   `quiz_attempts.score_pct`, which stays the authority); passed = score ≥ pass mark.
 * - Reveal: the learner always sees right/wrong for their OWN selections. The correct options
 *   and explanations (the answer key) are revealed only for a PASSED attempt. `buildQuizResult`
 *   drops any key it is handed for an attempt that did not pass, so a caller bug cannot leak it.
 */

/** A question of an attempt (frozen at START, attempt order). */
export interface AttemptQuestionRef {
  readonly questionId: string;
  readonly position: number;
}

/** What answer validation needs of a question of the attempt's revision (no key). */
export interface QuizQuestionShape {
  readonly id: string;
  readonly kind: QuizQuestionKind;
  readonly optionCount: number;
}

/** One question of the answer key (catalog `QuizAnswerKey`): grading and the post-pass reveal. */
export interface QuizKeyQuestion {
  readonly id: string;
  readonly kind: QuizQuestionKind;
  /** Correct option positions, ascending. */
  readonly correct: readonly number[];
  readonly explanationMd: string | null;
}

export interface SubmittedAnswer {
  readonly questionId: string;
  readonly optionPositions: readonly number[];
}

/**
 * Validates the answers against the attempt (ids of its questions, positions within the
 * question's options, at most one selection on a single-choice question, no duplicates) and
 * returns the selections per question id, ascending. Questions without an answer are absent.
 *
 * @throws QuizAnswersInvalid (422)
 */
export function normalizeAnswers(
  questions: readonly AttemptQuestionRef[],
  shapes: ReadonlyMap<string, QuizQuestionShape>,
  answers: readonly SubmittedAnswer[],
): Map<string, number[]> {
  const inAttempt = new Set(questions.map((q) => q.questionId));
  const result = new Map<string, number[]>();
  for (const answer of answers) {
    const questionId = answer.questionId.toLowerCase();
    const shape = shapes.get(questionId);
    if (!inAttempt.has(questionId) || shape === undefined) {
      throw new QuizAnswersInvalid(
        'An answer refers to a question that is not part of this attempt.',
      );
    }
    if (result.has(questionId)) {
      throw new QuizAnswersInvalid('Each question may be answered once.');
    }
    const positions = [...answer.optionPositions].sort((a, b) => a - b);
    if (new Set(positions).size !== positions.length) {
      throw new QuizAnswersInvalid('Option positions must be unique.');
    }
    if (positions.some((p) => !Number.isInteger(p) || p < 0 || p >= shape.optionCount)) {
      throw new QuizAnswersInvalid('An option position is out of range.');
    }
    if (shape.kind === 'SINGLE_CHOICE' && positions.length > 1) {
      throw new QuizAnswersInvalid('A single-choice question takes at most one option.');
    }
    if (positions.length > 0) result.set(questionId, positions);
  }
  return result;
}

export interface GradedQuestion {
  readonly questionId: string;
  readonly isCorrect: boolean;
}

export interface GradeOutcome {
  /** In attempt order. */
  readonly questions: readonly GradedQuestion[];
  readonly correctCount: number;
  readonly scorePct: number;
  readonly passed: boolean;
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** round(correct / total × 100), half away from zero (as `quiz_attempts.score_pct`). */
export function scorePctOf(correctCount: number, questionCount: number): number {
  if (questionCount <= 0) throw new RangeError('questionCount must be positive');
  return Math.round((correctCount * 100) / questionCount);
}

/**
 * Grades the attempt against its revision's key. A question of the attempt that the key does
 * not know is a data bug (the key is immutable per revision): it throws (500), never "wrong".
 */
export function gradeAttempt(
  questions: readonly AttemptQuestionRef[],
  selections: ReadonlyMap<string, readonly number[]>,
  key: { readonly passPct: number; readonly questions: readonly QuizKeyQuestion[] },
  passPct: number,
): GradeOutcome {
  if (questions.length === 0) throw new RangeError('an attempt has at least one question');
  const byId = new Map(key.questions.map((q) => [q.id.toLowerCase(), q]));
  const graded = [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question): GradedQuestion => {
      const keyed = byId.get(question.questionId.toLowerCase());
      if (keyed === undefined || keyed.correct.length === 0) {
        throw new Error(`answer key has no usable entry for question ${question.questionId}`);
      }
      const mine = selections.get(question.questionId) ?? [];
      return {
        questionId: question.questionId,
        isCorrect: mine.length > 0 && sameSet(mine, keyed.correct),
      };
    });
  const correctCount = graded.filter((q) => q.isCorrect).length;
  const scorePct = scorePctOf(correctCount, graded.length);
  return { questions: graded, correctCount, scorePct, passed: scorePct >= passPct };
}

/** The reveal policy (Q5, P5-D5): the key and explanations only for a passed attempt. */
export function revealsAnswerKey(passed: boolean): boolean {
  return passed;
}

/** A SUBMITTED attempt as stored (`quiz_attempts` + generated `score_pct` / `passed`). */
export interface SubmittedAttempt {
  readonly id: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly passPct: number;
  readonly questionCount: number;
  readonly correctCount: number;
  readonly scorePct: number;
  readonly passed: boolean;
  readonly submittedAt: Date;
}

/** A graded question of the attempt as stored (`quiz_attempt_questions`). */
export interface StoredGradedQuestion extends AttemptQuestionRef {
  readonly isCorrect: boolean;
}

/**
 * The learner's result. `key` is used only when the attempt passed (otherwise ignored), so
 * `correctOptions` / `explanationMd` are null for every failed attempt.
 */
export function buildQuizResult(
  attempt: SubmittedAttempt,
  questions: readonly StoredGradedQuestion[],
  selections: ReadonlyMap<string, readonly number[]>,
  key: { readonly questions: readonly QuizKeyQuestion[] } | null,
): QuizResult {
  const revealed = revealsAnswerKey(attempt.passed) && key !== null;
  const keyById = revealed
    ? new Map(key.questions.map((q) => [q.id.toLowerCase(), q]))
    : new Map<string, QuizKeyQuestion>();
  const results = [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question): QuizQuestionResult => {
      const keyed = keyById.get(question.questionId.toLowerCase());
      return {
        questionId: question.questionId,
        position: question.position,
        selectedOptions: [...(selections.get(question.questionId) ?? [])],
        yourAnswerCorrect: question.isCorrect,
        correctOptions: revealed && keyed !== undefined ? [...keyed.correct] : null,
        explanationMd: revealed && keyed !== undefined ? keyed.explanationMd : null,
      };
    });
  return {
    attemptId: attempt.id,
    courseId: attempt.courseId,
    lectureId: attempt.lectureId,
    scorePct: attempt.scorePct,
    correctCount: attempt.correctCount,
    questionCount: attempt.questionCount,
    passPct: attempt.passPct,
    passed: attempt.passed,
    revealed,
    submittedAt: attempt.submittedAt.toISOString(),
    questions: results,
  };
}
