import { Injectable } from '@nestjs/common';
import {
  type ProgressAck,
  type QuizAttempt,
  type QuizAttemptDetail,
  type QuizAttemptPage,
  QuizAttemptGraded,
  type SubmitQuizAttemptResponse,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { CatalogFacade, type LiveCurriculum } from '../../../catalog';
import { courseProgressOf } from '../../domain/completion-policy';
import {
  AttemptNotInProgress,
  QuizAttemptNotFound,
  QuizLectureRequired,
} from '../../domain/learning.errors';
import {
  gradeAttempt,
  normalizeAnswers,
  type QuizQuestionShape,
  type SubmittedAnswer,
} from '../../domain/quiz-grading';
import { CompletionRecorder } from '../completion-recorder';
import { isUuid, LearnerAccess, liveLecturesOf } from '../learner-access';
import { decodeLearningCursor, pageOf } from '../learning-cursor';
import { LearningEventPublisher } from '../ports/learning-event.publisher';
import { LearningRateLimiter } from '../ports/learning-rate-limiter';
import { LearningRepository } from '../ports/learning.repository';
import { QuizAttemptRepository, type QuizAttemptRecord } from '../ports/quiz-attempts.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { QuizAttemptPresenter, toAttemptSummary } from '../quiz-attempt.presenter';

export interface StartQuizAttemptResult {
  readonly attempt: QuizAttempt;
  /** true: 201 (a new attempt); false: 200 (the open attempt of the live revision). */
  readonly created: boolean;
}

/**
 * `StartQuizAttempt` (design §5, D6; `POST /me/courses/:courseId/lectures/:lectureId/quiz-attempts`).
 *
 * Requires an ACTIVE enrollment and a QUIZ lecture of the live revision. In ONE transaction:
 * lock the user's open attempt of the lecture; if it belongs to the live revision, return it
 * (200, resume); otherwise abandon it (a newer revision went live) and insert a new attempt
 * with the live revision's questions frozen in display order (201). Two parallel starts give
 * one attempt: the insert is `ON CONFLICT DO NOTHING` on the open-attempt index and the loser
 * re-reads the winner. The response is built from the learner-safe quiz only (no key).
 *
 * Stale attempts (older than `LEARNING_QUIZ_ATTEMPT_TTL_H`) are abandoned by the worker's
 * `LearningMaintenanceJob` (`_08`), not here.
 *
 * Errors: 404 `course_not_found` / `lecture_not_found`, 403 `enrollment_required`,
 * 422 `lecture_type_mismatch`, 429.
 */
@Injectable()
export class StartQuizAttemptCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly access: LearnerAccess,
    private readonly catalog: CatalogFacade,
    private readonly attempts: QuizAttemptRepository,
    private readonly presenter: QuizAttemptPresenter,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly courseId: string;
    readonly lectureId: string;
  }): Promise<StartQuizAttemptResult> {
    await this.rateLimiter.hit('quizStart', input.userId);
    const curriculum = await this.access.curriculum(input.courseId);
    const lecture = this.access.lecture(curriculum, input.lectureId);
    await this.access.requireLearner(input.userId, curriculum.courseId);
    if (lecture.type !== 'QUIZ') throw new QuizLectureRequired();
    const quiz = await this.catalog.getQuizForAttempt(curriculum.courseId, lecture.id);
    if (quiz === null || quiz.questions.length === 0) throw new QuizLectureRequired();
    const questionIds = [...quiz.questions]
      .sort((a, b) => a.position - b.position)
      .map((q) => q.id);

    const { attempt, created } = await this.tx.run(async (trx) => {
      const open = await this.attempts.lockOpen(trx, input.userId, lecture.id);
      if (open !== null) {
        if (open.revisionId === quiz.revisionId) return { attempt: open, created: false };
        await this.attempts.abandon(trx, open.id);
      }
      const inserted = await this.attempts.insert(trx, {
        userId: input.userId,
        courseId: curriculum.courseId,
        lectureId: lecture.id,
        revisionId: quiz.revisionId,
        passPct: quiz.passPct,
        questionIds,
      });
      if (inserted !== null) return { attempt: inserted, created: true };
      // A parallel start committed first: resume its attempt (READ COMMITTED, new statement).
      const winner = await this.attempts.lockOpen(trx, input.userId, lecture.id);
      if (winner === null) throw new Error('the concurrently started attempt is not open');
      return { attempt: winner, created: false };
    });
    return { attempt: await this.presenter.attemptView(attempt, quiz), created };
  }
}

export interface ListQuizAttemptsInput {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * `ListQuizAttempts` (`GET /me/courses/:courseId/lectures/:lectureId/quiz-attempts`): the
 * caller's attempts of a live lecture, newest first (keyset `(started_at DESC, id DESC)`).
 * Summaries only (score and pass), never a key.
 *
 * Errors: 404 `course_not_found` / `lecture_not_found`, 403 `enrollment_required`, 422 cursor.
 */
@Injectable()
export class ListQuizAttemptsQuery {
  constructor(
    private readonly access: LearnerAccess,
    private readonly attempts: QuizAttemptRepository,
  ) {}

  async execute(input: ListQuizAttemptsInput): Promise<QuizAttemptPage> {
    const curriculum = await this.access.curriculum(input.courseId);
    const lecture = this.access.lecture(curriculum, input.lectureId);
    await this.access.requireLearner(input.userId, curriculum.courseId);
    const after = input.cursor === undefined ? null : decodeLearningCursor(input.cursor);
    const rows = await this.attempts.listPage({
      userId: input.userId,
      lectureId: lecture.id,
      after,
      limit: input.limit + 1,
    });
    return pageOf(
      rows,
      input.limit,
      (row) => row.keyset,
      (row) => toAttemptSummary(row.attempt),
    );
  }
}

/**
 * `GetQuizAttempt` (`GET /me/quiz-attempts/:attemptId`, Pol `quiz_attempt:read`): the caller's
 * attempt with its questions and, once SUBMITTED, the result under the reveal policy.
 *
 * Errors: 404 `quiz_attempt_not_found`.
 */
@Injectable()
export class GetQuizAttemptQuery {
  constructor(
    private readonly attempts: QuizAttemptRepository,
    private readonly presenter: QuizAttemptPresenter,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly attemptId: string;
  }): Promise<QuizAttemptDetail> {
    const attempt = isUuid(input.attemptId)
      ? await this.attempts.findOwn(input.userId, input.attemptId)
      : null;
    if (attempt === null) throw new QuizAttemptNotFound();
    return this.presenter.detail(attempt);
  }
}

export interface SubmitQuizAttemptInput {
  readonly userId: string;
  readonly attemptId: string;
  readonly answers: readonly SubmittedAnswer[];
}

/**
 * `SubmitQuizAttempt` (design §5, D6; `POST /me/quiz-attempts/:attemptId/submit`,
 * Pol `quiz_attempt:submit`).
 *
 * In ONE transaction, under the attempt row lock (`FOR UPDATE`):
 * 1. ABANDONED: 409 `attempt_not_in_progress`. SUBMITTED: the stored result (idempotent 200).
 * 2. Validate the answers against the attempt's questions and its revision's options
 *    (422 `quiz_answers_invalid`), grade them server-side against THAT revision's key
 *    (`CatalogFacade.getQuizAnswerKey`), store the per-question grades and the selections, and
 *    move the attempt to SUBMITTED conditionally (`WHERE status = 'IN_PROGRESS'`; the abandon
 *    job uses `SKIP LOCKED`, so one of them wins).
 * 3. Outbox `QuizAttemptGraded`; when passed and the lecture is still in the live curriculum,
 *    `CompletionRecorder.complete(QUIZ_PASSED, quizAttemptId)`: lecture completion,
 *    `LectureCompleted`, and possibly `CourseCompleted`, all in the same transaction.
 *
 * The grading key never leaves this transaction: the response is built by the presenter, which
 * loads the key again only for a PASSED attempt (reveal policy).
 *
 * D9: grading requires an ACTIVE enrollment (403 `enrollment_required`), like every learner
 * write; reading one's own attempts does not.
 *
 * Errors: 404 `quiz_attempt_not_found`, 403 `enrollment_required`, 409, 422, 429.
 */
@Injectable()
export class SubmitQuizAttemptCommand {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly access: LearnerAccess,
    private readonly catalog: CatalogFacade,
    private readonly attempts: QuizAttemptRepository,
    private readonly presenter: QuizAttemptPresenter,
    private readonly recorder: CompletionRecorder,
    private readonly completions: LearningRepository,
    private readonly events: LearningEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: SubmitQuizAttemptInput): Promise<SubmitQuizAttemptResponse> {
    await this.rateLimiter.hit('quizSubmit', input.userId);
    const found = isUuid(input.attemptId)
      ? await this.attempts.findOwn(input.userId, input.attemptId)
      : null;
    if (found === null) throw new QuizAttemptNotFound();
    await this.access.requireLearner(input.userId, found.courseId);
    if (found.status === 'ABANDONED') throw new AttemptNotInProgress();
    const curriculum = await this.catalog.getLiveCurriculum(found.courseId);

    const attempt = await this.tx.run(async (trx) => {
      const locked = await this.attempts.findOwn(input.userId, found.id, {
        ex: trx,
        forUpdate: true,
      });
      if (locked === null) throw new QuizAttemptNotFound();
      if (locked.status === 'ABANDONED') throw new AttemptNotInProgress();
      if (locked.status === 'SUBMITTED') return locked;
      return this.grade(trx, locked, input, curriculum);
    });

    const result = await this.presenter.result(attempt);
    if (result === null) throw new Error(`attempt ${attempt.id} was not submitted`);
    return { ...result, progress: await this.progressAck(input.userId, attempt, curriculum) };
  }

  private async grade(
    trx: Transaction<DB>,
    attempt: QuizAttemptRecord,
    input: SubmitQuizAttemptInput,
    curriculum: LiveCurriculum | null,
  ): Promise<QuizAttemptRecord> {
    const questions = await this.attempts.listQuestions(attempt.id, trx);
    const quiz = await this.presenter.learnerQuiz(attempt, trx);
    const shapes = new Map<string, QuizQuestionShape>(
      quiz.questions.map((q) => [
        q.id.toLowerCase(),
        { id: q.id, kind: q.kind, optionCount: q.options.length },
      ]),
    );
    const selections = normalizeAnswers(questions, shapes, input.answers);
    const key = await this.catalog.getQuizAnswerKey(attempt.revisionId, attempt.lectureId, trx);
    if (key === null) {
      throw new Error(`no answer key of revision ${attempt.revisionId} for attempt ${attempt.id}`);
    }
    const outcome = gradeAttempt(questions, selections, key, attempt.passPct);
    const stored = await this.attempts.submit(trx, {
      attemptId: attempt.id,
      graded: outcome.questions,
      selections,
      correctCount: outcome.correctCount,
    });
    // Unreachable under the row lock (the abandon job skips locked rows); kept as the guard.
    if (stored === null) throw new AttemptNotInProgress();
    if (stored.scorePct === null || stored.passed === null || stored.submittedAt === null) {
      throw new Error(`attempt ${stored.id} has no stored result after SUBMIT`);
    }

    await this.events.publish(trx, QuizAttemptGraded, {
      attemptId: stored.id,
      userId: stored.userId,
      courseId: stored.courseId,
      lectureId: stored.lectureId,
      revisionId: stored.revisionId,
      scorePct: stored.scorePct,
      passed: stored.passed,
      gradedAt: stored.submittedAt.toISOString(),
    });

    if (stored.passed && curriculum !== null) {
      const lecture = liveLecturesOf(curriculum).find(
        (l) => l.id === stored.lectureId && l.type === 'QUIZ',
      );
      // A quiz removed by a later revision is graded but no longer counts toward the course.
      if (lecture !== undefined) {
        await this.recorder.complete(trx, {
          userId: stored.userId,
          curriculum,
          lecture,
          cause: 'QUIZ_PASSED',
          quizAttemptId: stored.id,
        });
      }
    }
    return stored;
  }

  /** The lecture and course state after the submit (`ProgressAck`). */
  private async progressAck(
    userId: string,
    attempt: QuizAttemptRecord,
    curriculum: LiveCurriculum | null,
  ): Promise<ProgressAck> {
    const completed = new Set(
      await this.completions.listCompletedLectureIds(userId, attempt.courseId),
    );
    const courseCompletion = await this.completions.findCourseCompletion(userId, attempt.courseId);
    const live = curriculum === null ? [] : liveLecturesOf(curriculum).map((l) => l.id);
    return {
      lectureCompleted: completed.has(attempt.lectureId),
      courseCompleted: courseCompletion !== null,
      coursePct: courseProgressOf(completed, live).pct,
    };
  }
}
