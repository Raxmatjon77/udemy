import type { CertificateStatus, LectureCompletionCause, LectureType } from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';

export interface RecordCompletionCommand {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly lectureType: LectureType;
  readonly cause: LectureCompletionCause;
  /** Live revision at completion. */
  readonly revisionId: string;
  /** Every lecture id of that live revision (the course-completion check, D5). */
  readonly liveLectureIds: readonly string[];
  /** QUIZ_PASSED only (P5-T11): the passing, submitted attempt. */
  readonly quizAttemptId?: string | null;
}

export interface CourseCompletionRecord {
  readonly completedAt: Date;
  /** This call inserted it (-> `CourseCompleted`). */
  readonly newlyCompleted: boolean;
}

export interface CourseCompletionEvaluation {
  /** Completed ∩ live lecture ids. */
  readonly completedLectures: number;
  /** Live lecture count. */
  readonly totalLectures: number;
  /** The permanent course completion, if any (even when a later revision added lectures). */
  readonly completion: CourseCompletionRecord | null;
}

export interface RecordCompletionResult {
  /** Set when THIS call completed the lecture (-> `LectureCompleted`); null if it already was. */
  readonly lectureCompletedAt: Date | null;
  readonly course: CourseCompletionEvaluation;
}

export interface LectureCompletionRecord {
  readonly lectureId: string;
  readonly cause: LectureCompletionCause;
  readonly completedAt: Date;
}

export interface CertificateRef {
  readonly id: string;
  readonly code: string;
  readonly status: CertificateStatus;
}

/** One live lecture as the consumption query needs it (`@udemy/db` `LiveLecture`). */
export interface ConsumptionLecture {
  readonly lectureId: string;
  readonly type: LectureType;
  readonly mediaAssetId: string | null;
  readonly durationSeconds: number | null;
}

export interface ConsumptionFigures {
  readonly videoSecondsWatched: number;
  readonly videoSecondsTotal: number;
  readonly completedLectures: number;
  readonly totalLectures: number;
  readonly courseCompletedAt: Date | null;
  readonly certificateStatus: CertificateStatus | null;
}

/**
 * Completions, course completions and the learner's certificate reference
 * (`learning.lecture_completions`, `course_completions`, `certificates`), through the
 * `@udemy/db` operational SQL (schema doc §8.2, §8.3). Every write takes the `lrnc`
 * (user, course) advisory lock first, in the caller's transaction (R1).
 */
export abstract class LearningRepository {
  /** lrnc lock -> insert the lecture completion (ON CONFLICT DO NOTHING) -> evaluate the course. */
  abstract recordCompletion(
    trx: Transaction<DB>,
    command: RecordCompletionCommand,
  ): Promise<RecordCompletionResult>;

  /** lrnc lock -> EvaluateCourseCompletion alone (the lazy re-evaluation of the bootstrap, D5). */
  abstract evaluateCourseCompletion(
    trx: Transaction<DB>,
    input: {
      readonly userId: string;
      readonly courseId: string;
      readonly revisionId: string;
      readonly liveLectureIds: readonly string[];
    },
  ): Promise<CourseCompletionEvaluation>;

  /** lrnc lock -> DELETE; the removed row's type, or null when it was not completed. */
  abstract clearCompletion(
    trx: Transaction<DB>,
    input: { readonly userId: string; readonly courseId: string; readonly lectureId: string },
  ): Promise<{ readonly lectureType: LectureType } | null>;

  /** Every completion of (user, course), whatever the revision. */
  abstract listCompletions(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<LectureCompletionRecord[]>;

  /** Completed lecture ids of (user, course) (index-only). */
  abstract listCompletedLectureIds(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<string[]>;

  abstract findCourseCompletion(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<{ readonly completedAt: Date } | null>;

  abstract findCertificate(
    userId: string,
    courseId: string,
    ex?: Executor,
  ): Promise<CertificateRef | null>;

  /** Completed ∩ live lecture ids for many courses in one GROUP BY (`getPercents`). */
  abstract progressCounts(
    userId: string,
    courses: readonly { readonly courseId: string; readonly lectureIds: readonly string[] }[],
    ex?: Executor,
  ): Promise<Map<string, { readonly completed: number; readonly total: number }>>;

  /** The refund-policy figures (§8.3); reads only, no locks. */
  abstract consumption(
    userId: string,
    courseId: string,
    lectures: readonly ConsumptionLecture[],
    ex?: Executor,
  ): Promise<ConsumptionFigures>;
}
