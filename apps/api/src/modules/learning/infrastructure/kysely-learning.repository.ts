import { Injectable } from '@nestjs/common';
import type { CertificateStatus, LectureCompletionCause, LectureType } from '@udemy/contracts';
import {
  clearLectureCompletion,
  type DB,
  evaluateCourseCompletion,
  type Executor,
  getCourseProgressCounts,
  getLearningConsumption,
  listCompletedLectureIds,
  lockLearningCompletion,
  recordLectureCompletion,
  type Transaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type CertificateRef,
  type ConsumptionFigures,
  type ConsumptionLecture,
  type CourseCompletionEvaluation,
  type LectureCompletionRecord,
  LearningRepository,
  type RecordCompletionCommand,
  type RecordCompletionResult,
} from '../application/ports/learning.repository';
import { rethrowLearningConstraint } from './learning-constraint-errors';

async function mapped<T>(statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    return rethrowLearningConstraint(error);
  }
}

/**
 * Completions, course completions and certificate references through the `@udemy/db`
 * operational SQL (schema doc §8.2, §8.3): `recordLectureCompletion` takes the `lrnc` lock,
 * inserts ON CONFLICT DO NOTHING RETURNING, then evaluates the course in a new statement (R1).
 * Plain reads use the query builder.
 */
@Injectable()
export class KyselyLearningRepository extends LearningRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async recordCompletion(
    trx: Transaction<DB>,
    command: RecordCompletionCommand,
  ): Promise<RecordCompletionResult> {
    const result = await mapped(() =>
      recordLectureCompletion(trx, {
        userId: command.userId,
        courseId: command.courseId,
        lectureId: command.lectureId,
        lectureType: command.lectureType,
        cause: command.cause,
        revisionId: command.revisionId,
        quizAttemptId: command.quizAttemptId ?? null,
        liveLectureIds: command.liveLectureIds,
      }),
    );
    return { lectureCompletedAt: result.lecture?.completedAt ?? null, course: result.course };
  }

  async evaluateCourseCompletion(
    trx: Transaction<DB>,
    input: {
      readonly userId: string;
      readonly courseId: string;
      readonly revisionId: string;
      readonly liveLectureIds: readonly string[];
    },
  ): Promise<CourseCompletionEvaluation> {
    await lockLearningCompletion(trx, input.userId, input.courseId);
    return evaluateCourseCompletion(trx, input);
  }

  async clearCompletion(
    trx: Transaction<DB>,
    input: { readonly userId: string; readonly courseId: string; readonly lectureId: string },
  ): Promise<{ readonly lectureType: LectureType } | null> {
    const removed = await clearLectureCompletion(trx, input);
    return removed === null ? null : { lectureType: removed.lectureType };
  }

  async listCompletions(
    userId: string,
    courseId: string,
    ex: Executor = this.db,
  ): Promise<LectureCompletionRecord[]> {
    const rows = await ex
      .selectFrom('learning.lectureCompletions')
      .select(['lectureId', 'cause', 'completedAt'])
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .orderBy('lectureId')
      .execute();
    return rows.map((r) => ({
      lectureId: r.lectureId,
      cause: r.cause as LectureCompletionCause,
      completedAt: r.completedAt,
    }));
  }

  listCompletedLectureIds(
    userId: string,
    courseId: string,
    ex: Executor = this.db,
  ): Promise<string[]> {
    return listCompletedLectureIds(ex, userId, courseId);
  }

  async findCourseCompletion(
    userId: string,
    courseId: string,
    ex: Executor = this.db,
  ): Promise<{ readonly completedAt: Date } | null> {
    const row = await ex
      .selectFrom('learning.courseCompletions')
      .select('completedAt')
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row === undefined ? null : { completedAt: row.completedAt };
  }

  async findCertificate(
    userId: string,
    courseId: string,
    ex: Executor = this.db,
  ): Promise<CertificateRef | null> {
    const row = await ex
      .selectFrom('learning.certificates')
      .select(['id', 'publicCode', 'status'])
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row === undefined
      ? null
      : { id: row.id, code: row.publicCode, status: row.status as CertificateStatus };
  }

  progressCounts(
    userId: string,
    courses: readonly { readonly courseId: string; readonly lectureIds: readonly string[] }[],
    ex: Executor = this.db,
  ): Promise<Map<string, { readonly completed: number; readonly total: number }>> {
    return getCourseProgressCounts(ex, userId, courses);
  }

  async consumption(
    userId: string,
    courseId: string,
    lectures: readonly ConsumptionLecture[],
    ex: Executor = this.db,
  ): Promise<ConsumptionFigures> {
    const figures = await getLearningConsumption(ex, { userId, courseId, lectures });
    return {
      videoSecondsWatched: figures.videoSecondsWatched,
      videoSecondsTotal: figures.videoSecondsTotal,
      completedLectures: figures.completedLectures,
      totalLectures: figures.totalLectures,
      courseCompletedAt: figures.courseCompletedAt,
      certificateStatus: figures.certificateStatus,
    };
  }
}
