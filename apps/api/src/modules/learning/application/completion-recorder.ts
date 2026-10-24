import { Injectable } from '@nestjs/common';
import {
  CourseCompleted,
  LectureCompleted,
  LectureCompletionCleared,
  type LectureCompletionCause,
  progressPct,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import type { LiveCurriculum, LiveCurriculumLecture } from '../../catalog';
import { assertServerCompletionAllowed } from '../domain/completion-policy';
import { liveLecturesOf } from './learner-access';
import { LearningEventPublisher } from './ports/learning-event.publisher';
import { type CourseCompletionEvaluation, LearningRepository } from './ports/learning.repository';

export interface CompleteLectureInput {
  readonly userId: string;
  /** The live curriculum the lecture was resolved in (its revision and lecture set count). */
  readonly curriculum: LiveCurriculum;
  readonly lecture: LiveCurriculumLecture;
  readonly cause: LectureCompletionCause;
  /** QUIZ_PASSED only (P5-T11): the passing attempt, submitted in the same transaction. */
  readonly quizAttemptId?: string | null;
}

export interface CompletionOutcome {
  /** This call completed the lecture (and wrote `LectureCompleted`). */
  readonly lectureNewlyCompleted: boolean;
  /** This call completed the course (and wrote `CourseCompleted`). */
  readonly courseNewlyCompleted: boolean;
  readonly course: CourseCompletionEvaluation;
}

/** `{ completed, total, pct }` of an evaluation (D5). */
export function progressOfEvaluation(course: CourseCompletionEvaluation): {
  completed: number;
  total: number;
  pct: number;
} {
  return {
    completed: course.completedLectures,
    total: course.totalLectures,
    pct: progressPct(course.completedLectures, course.totalLectures),
  };
}

/**
 * The synchronous completion writes of design D2/D5 (`CompleteLecture`,
 * `EvaluateCourseCompletion`, `UncompleteLecture`), in the CALLER's transaction so the
 * completion, the course completion and their outbox events commit together:
 *
 * - every write takes the `lrnc` (user, course) advisory lock first (two-int class 'lrnc'),
 *   then inserts with `ON CONFLICT DO NOTHING RETURNING`, then checks completed ⊇ live ids in
 *   a new statement (R1): two heartbeats crossing 90 % at once, or the last two lectures
 *   completed in parallel, give exactly one `LectureCompleted` and one `CourseCompleted`;
 * - the course completion is permanent (never deleted, P5-D3); un-completing a lecture never
 *   touches it or a certificate.
 *
 * Extension point (P5-T11): `SubmitQuizAttempt` calls `complete(trx, { cause: 'QUIZ_PASSED',
 * quizAttemptId })` inside its grading transaction.
 */
@Injectable()
export class CompletionRecorder {
  constructor(
    private readonly completions: LearningRepository,
    private readonly events: LearningEventPublisher,
  ) {}

  async complete(trx: Transaction<DB>, input: CompleteLectureInput): Promise<CompletionOutcome> {
    const { userId, curriculum, lecture, cause } = input;
    assertServerCompletionAllowed(lecture.type, cause);
    const result = await this.completions.recordCompletion(trx, {
      userId,
      courseId: curriculum.courseId,
      lectureId: lecture.id,
      lectureType: lecture.type,
      cause,
      revisionId: curriculum.liveRevisionId,
      liveLectureIds: liveLecturesOf(curriculum).map((l) => l.id),
      quizAttemptId: input.quizAttemptId ?? null,
    });
    if (result.lectureCompletedAt !== null) {
      await this.events.publish(trx, LectureCompleted, {
        userId,
        courseId: curriculum.courseId,
        lectureId: lecture.id,
        lectureType: lecture.type,
        revisionId: curriculum.liveRevisionId,
        cause,
        completedAt: result.lectureCompletedAt.toISOString(),
      });
    }
    const courseNewlyCompleted = await this.publishCourseCompletion(
      trx,
      userId,
      curriculum,
      result.course,
    );
    return {
      lectureNewlyCompleted: result.lectureCompletedAt !== null,
      courseNewlyCompleted,
      course: result.course,
    };
  }

  /**
   * EvaluateCourseCompletion on its own (D5: lazily on the bootstrap, e.g. a revision that only
   * REMOVED the last missing lecture completes the course on the next visit).
   */
  async evaluate(
    trx: Transaction<DB>,
    userId: string,
    curriculum: LiveCurriculum,
  ): Promise<CompletionOutcome> {
    const course = await this.completions.evaluateCourseCompletion(trx, {
      userId,
      courseId: curriculum.courseId,
      revisionId: curriculum.liveRevisionId,
      liveLectureIds: liveLecturesOf(curriculum).map((l) => l.id),
    });
    const courseNewlyCompleted = await this.publishCourseCompletion(
      trx,
      userId,
      curriculum,
      course,
    );
    return { lectureNewlyCompleted: false, courseNewlyCompleted, course };
  }

  /** Deletes the completion (idempotent); true when one was removed (`LectureCompletionCleared`). */
  async clear(
    trx: Transaction<DB>,
    input: { readonly userId: string; readonly courseId: string; readonly lectureId: string },
    clearedAt: Date,
  ): Promise<boolean> {
    const removed = await this.completions.clearCompletion(trx, input);
    if (removed === null) return false;
    await this.events.publish(trx, LectureCompletionCleared, {
      userId: input.userId,
      courseId: input.courseId,
      lectureId: input.lectureId,
      clearedAt: clearedAt.toISOString(),
    });
    return true;
  }

  private async publishCourseCompletion(
    trx: Transaction<DB>,
    userId: string,
    curriculum: LiveCurriculum,
    course: CourseCompletionEvaluation,
  ): Promise<boolean> {
    const completion = course.completion;
    if (completion === null || !completion.newlyCompleted) return false;
    await this.events.publish(trx, CourseCompleted, {
      userId,
      courseId: curriculum.courseId,
      revisionId: curriculum.liveRevisionId,
      lectureCount: course.totalLectures,
      completedAt: completion.completedAt.toISOString(),
    });
    return true;
  }
}
