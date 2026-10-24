import { Injectable } from '@nestjs/common';
import type {
  QuizAttempt,
  QuizAttemptDetail,
  QuizAttemptQuestion,
  QuizAttemptSummary,
  QuizResult,
} from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { CatalogFacade, type QuizForAttempt } from '../../catalog';
import {
  buildQuizResult,
  revealsAnswerKey,
  type StoredGradedQuestion,
  type SubmittedAttempt,
} from '../domain/quiz-grading';
import {
  type AttemptQuestionRecord,
  QuizAttemptRepository,
  type QuizAttemptRecord,
} from './ports/quiz-attempts.repository';

/**
 * The attempt's questions as the learner sees them: built field by field (an allow-list) from
 * the attempt's frozen order and the LEARNER-SAFE quiz of its revision, so no key field can
 * ever reach the response, whatever catalog returns.
 */
export function toAttemptQuestions(
  questions: readonly AttemptQuestionRecord[],
  quiz: QuizForAttempt,
): QuizAttemptQuestion[] {
  const byId = new Map(quiz.questions.map((q) => [q.id.toLowerCase(), q]));
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question) => {
      const learner = byId.get(question.questionId.toLowerCase());
      if (learner === undefined) {
        throw new Error(
          `revision ${quiz.revisionId} has no question ${question.questionId} of an attempt`,
        );
      }
      return {
        id: question.questionId,
        position: question.position,
        kind: learner.kind,
        promptMd: learner.promptMd,
        options: learner.options.map((option) => ({
          position: option.position,
          text: option.text,
        })),
      };
    });
}

export function toAttemptView(
  attempt: QuizAttemptRecord,
  questions: readonly AttemptQuestionRecord[],
  quiz: QuizForAttempt,
): QuizAttempt {
  return {
    id: attempt.id,
    courseId: attempt.courseId,
    lectureId: attempt.lectureId,
    revisionId: attempt.revisionId,
    status: attempt.status,
    passPct: attempt.passPct,
    questionCount: attempt.questionCount,
    startedAt: attempt.startedAt.toISOString(),
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    abandonedAt: attempt.abandonedAt?.toISOString() ?? null,
    questions: toAttemptQuestions(questions, quiz),
  };
}

export function toAttemptSummary(attempt: QuizAttemptRecord): QuizAttemptSummary {
  return {
    id: attempt.id,
    lectureId: attempt.lectureId,
    revisionId: attempt.revisionId,
    status: attempt.status,
    scorePct: attempt.scorePct,
    passed: attempt.passed,
    startedAt: attempt.startedAt.toISOString(),
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
  };
}

/** The stored result of a SUBMITTED attempt; anything else is a data bug. */
export function submittedAttemptOf(attempt: QuizAttemptRecord): SubmittedAttempt {
  if (
    attempt.status !== 'SUBMITTED' ||
    attempt.correctCount === null ||
    attempt.scorePct === null ||
    attempt.passed === null ||
    attempt.submittedAt === null
  ) {
    throw new Error(`attempt ${attempt.id} has no stored result`);
  }
  return {
    id: attempt.id,
    courseId: attempt.courseId,
    lectureId: attempt.lectureId,
    passPct: attempt.passPct,
    questionCount: attempt.questionCount,
    correctCount: attempt.correctCount,
    scorePct: attempt.scorePct,
    passed: attempt.passed,
    submittedAt: attempt.submittedAt,
  };
}

/**
 * Presents attempts (design §4 QuizAttempt, Q5 / P5-D5). The ONLY place a learner response
 * meets the answer key: `result` asks catalog for `getQuizAnswerKey` exclusively when the
 * attempt PASSED (the reveal policy), and `buildQuizResult` ignores a key for a failed attempt
 * anyway. Open, abandoned and failed attempts never load the key here.
 */
@Injectable()
export class QuizAttemptPresenter {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly attempts: QuizAttemptRepository,
  ) {}

  /** The learner-safe quiz of the attempt's revision (it may no longer be live). */
  async learnerQuiz(attempt: QuizAttemptRecord, ex?: Executor): Promise<QuizForAttempt> {
    const quiz = await this.catalog.getQuizForRevision(attempt.revisionId, attempt.lectureId, ex);
    if (quiz === null) {
      throw new Error(`no quiz of revision ${attempt.revisionId} for attempt ${attempt.id}`);
    }
    return quiz;
  }

  async attemptView(
    attempt: QuizAttemptRecord,
    quiz?: QuizForAttempt,
    ex?: Executor,
  ): Promise<QuizAttempt> {
    const questions = await this.attempts.listQuestions(attempt.id, ex);
    const learner =
      quiz !== undefined && quiz.revisionId === attempt.revisionId
        ? quiz
        : await this.learnerQuiz(attempt, ex);
    return toAttemptView(attempt, questions, learner);
  }

  /** The result of a SUBMITTED attempt (null otherwise), following the reveal policy. */
  async result(attempt: QuizAttemptRecord, ex?: Executor): Promise<QuizResult | null> {
    if (attempt.status !== 'SUBMITTED') return null;
    const submitted = submittedAttemptOf(attempt);
    const questions = await this.attempts.listQuestions(attempt.id, ex);
    const selections = await this.attempts.listSelections(attempt.id, ex);
    const graded: StoredGradedQuestion[] = questions.map((q) => {
      if (q.isCorrect === null) throw new Error(`attempt ${attempt.id} has an ungraded question`);
      return { questionId: q.questionId, position: q.position, isCorrect: q.isCorrect };
    });
    const key = revealsAnswerKey(submitted.passed)
      ? await this.catalog.getQuizAnswerKey(attempt.revisionId, attempt.lectureId, ex)
      : null;
    return buildQuizResult(submitted, graded, selections, key);
  }

  async detail(attempt: QuizAttemptRecord, ex?: Executor): Promise<QuizAttemptDetail> {
    const view = await this.attemptView(attempt, undefined, ex);
    return { ...view, result: await this.result(attempt, ex) };
  }
}
