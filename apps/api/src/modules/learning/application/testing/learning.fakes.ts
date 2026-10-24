import type {
  CertificateStatus,
  EventDefinition,
  EventPayloadInput,
  LectureCompletionCause,
  LectureType,
  PublicProfile,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import { RateLimitedError } from '../../../../shared/errors';
import type {
  CatalogFacade,
  CourseSummary,
  LiveCurriculum,
  LiveCurriculumIndexEntry,
  LiveCurriculumLecture,
  QuizAnswerKey,
  QuizForAttempt,
} from '../../../catalog';
import type { EnrollmentFacade } from '../../../enrollment';
import type { UsersFacade } from '../../../users';
import {
  acceptPlayedRanges,
  bucketCountOf,
  bucketSpansOf,
  CoverageBitmap,
  plausibilityBudgetSeconds,
} from '../../domain/progress-rules';
import { CompletionRecorder } from '../completion-recorder';
import { LearnerAccess } from '../learner-access';
import { LearningFacade } from '../learning.facade';
import { LearningProgressReader } from '../learning-progress.reader';
import { LearningSettings } from '../learning-settings';
import { AccessCache } from '../ports/access-cache';
import { LearningClock } from '../ports/learning-clock';
import { LearningEventPublisher } from '../ports/learning-event.publisher';
import { LearningRateLimiter, type LearningRateLimitName } from '../ports/learning-rate-limiter';
import {
  type CertificateRef,
  type ConsumptionFigures,
  type ConsumptionLecture,
  type CourseCompletionEvaluation,
  type LectureCompletionRecord,
  LearningRepository,
  type RecordCompletionCommand,
  type RecordCompletionResult,
} from '../ports/learning.repository';
import { type ClaimedBatch, ProgressFlushQueue } from '../ports/progress-flush-queue';
import {
  type ActivityRow,
  type ProgressBatchResult,
  ProgressRepository,
  type ProgressRow,
  type StoredCoverage,
  type StoredProgress,
} from '../ports/progress.repository';
import {
  type LiveLectureProgress,
  ProgressStore,
  type RecordProgressInput,
  type RecordProgressResult,
  type VideoLectureRef,
} from '../ports/progress-store';
import { TransactionRunner } from '../ports/transaction-runner';
import { ProgressFlushJob } from '../progress-flush.job';
import { CompleteLectureCommand } from '../use-cases/complete-lecture.command';
import { GetPlayerBootstrapQuery } from '../use-cases/get-player-bootstrap.query';
import { RecordHeartbeatCommand } from '../use-cases/record-heartbeat.command';
import { UncompleteLectureCommand } from '../use-cases/uncomplete-lecture.command';

/** Stands in for an open Kysely transaction (fakes never run SQL). */
export const FAKE_TRX = { isTransaction: true } as unknown as Transaction<DB>;

export const STUDENT = '01900000-0000-7000-8000-00000000a001';
export const OTHER_STUDENT = '01900000-0000-7000-8000-00000000a002';
export const OWNER = '01900000-0000-7000-8000-00000000b001';
export const COURSE = '01900000-0000-7000-8000-00000000c001';
export const REVISION = '01900000-0000-7000-8000-00000000d001';
export const SECTION = '01900000-0000-7000-8000-00000000e001';
export const VIDEO = '01900000-0000-7000-8000-00000000f001';
export const ARTICLE = '01900000-0000-7000-8000-00000000f002';
export const RESOURCE = '01900000-0000-7000-8000-00000000f003';
export const QUIZ = '01900000-0000-7000-8000-00000000f004';
export const ASSET = '01900000-0000-7000-8000-0000000aa001';
export const FILE_ASSET = '01900000-0000-7000-8000-0000000aa002';
/** A lecture of ANOTHER course (IDOR: 404 through this course's path). */
export const FOREIGN_LECTURE = '01900000-0000-7000-8000-00000000f999';

/** 100 s video = 20 buckets of 5 s; 90 % = 18 buckets. */
export const VIDEO_SECONDS = 100;

export function lecture(
  id: string,
  type: LectureType,
  extra: Partial<LiveCurriculumLecture> = {},
): LiveCurriculumLecture {
  return {
    id,
    type,
    title: `${type} ${id.slice(-4)}`,
    durationSeconds: type === 'VIDEO' ? VIDEO_SECONDS : null,
    isPreview: false,
    mediaAssetId: type === 'VIDEO' ? ASSET : type === 'RESOURCE' ? FILE_ASSET : null,
    quiz: type === 'QUIZ' ? { questionCount: 3, passPct: 70 } : null,
    ...extra,
  };
}

/** A PUBLISHED course with a video, an article, a resource and a quiz. */
export function curriculumOf(lectures?: readonly LiveCurriculumLecture[]): LiveCurriculum {
  return {
    courseId: COURSE,
    ownerId: OWNER,
    status: 'PUBLISHED',
    liveRevisionId: REVISION,
    slug: 'typescript-from-scratch',
    title: 'TypeScript from scratch',
    sections: [
      {
        id: SECTION,
        title: 'Basics',
        lectures: lectures ?? [
          lecture(VIDEO, 'VIDEO'),
          lecture(ARTICLE, 'ARTICLE'),
          lecture(RESOURCE, 'RESOURCE'),
          lecture(QUIZ, 'QUIZ'),
        ],
      },
    ],
  };
}

/** The catalog seen by learning: one mutable map of live curricula. */
export class FakeCatalog {
  readonly curricula = new Map<string, LiveCurriculum>();
  readonly indexCalls: string[][] = [];

  constructor(curriculum: LiveCurriculum = curriculumOf()) {
    this.curricula.set(curriculum.courseId, curriculum);
  }

  getLiveCurriculum(courseId: string, _ex?: Executor): Promise<LiveCurriculum | null> {
    return Promise.resolve(this.curricula.get(courseId) ?? null);
  }

  getLiveCurriculumIndex(
    courseIds: readonly string[],
    _ex?: Executor,
  ): Promise<Map<string, LiveCurriculumIndexEntry>> {
    if (courseIds.length > 48) throw new RangeError('more than 48 ids');
    this.indexCalls.push([...courseIds]);
    const result = new Map<string, LiveCurriculumIndexEntry>();
    for (const id of courseIds) {
      const c = this.curricula.get(id);
      if (c === undefined) continue;
      const lectures = c.sections.flatMap((s) => s.lectures);
      result.set(id, {
        liveRevisionId: c.liveRevisionId,
        lectureIds: lectures.map((l) => l.id),
        videoSecondsTotal: lectures.reduce((sum, l) => sum + (l.durationSeconds ?? 0), 0),
      });
    }
    return Promise.resolve(result);
  }

  /* ---------------------------------------------------------------- quizzes (P5-T11) */

  /** `${revisionId}:${lectureId}` -> the revision's quiz WITH its key (as catalog stores it). */
  readonly quizzes = new Map<string, FakeQuizContent>();
  /** Every `getQuizAnswerKey` call (the reveal tests assert when the key is loaded). */
  readonly answerKeyCalls: string[] = [];

  setQuiz(revisionId: string, lectureId: string, quiz: FakeQuizContent): void {
    this.quizzes.set(`${revisionId}:${lectureId}`, quiz);
  }

  getQuizForAttempt(
    courseId: string,
    lectureId: string,
    _ex?: Executor,
  ): Promise<QuizForAttempt | null> {
    const curriculum = this.curricula.get(courseId);
    if (curriculum === undefined) return Promise.resolve(null);
    return this.getQuizForRevision(curriculum.liveRevisionId, lectureId);
  }

  /** The learner view: built from an allow-list, exactly like catalog's `toLearnerQuiz`. */
  getQuizForRevision(
    revisionId: string,
    lectureId: string,
    _ex?: Executor,
  ): Promise<QuizForAttempt | null> {
    const quiz = this.quizzes.get(`${revisionId}:${lectureId}`);
    if (quiz === undefined) return Promise.resolve(null);
    return Promise.resolve({
      revisionId,
      passPct: quiz.passPct,
      questions: quiz.questions.map((q, position) => ({
        id: q.id,
        position,
        kind: q.kind,
        promptMd: q.promptMd,
        options: q.options.map((o, i) => ({ position: i, text: o.text })),
      })),
    });
  }

  getQuizAnswerKey(
    revisionId: string,
    lectureId: string,
    _ex?: Executor,
  ): Promise<QuizAnswerKey | null> {
    this.answerKeyCalls.push(`${revisionId}:${lectureId}`);
    const quiz = this.quizzes.get(`${revisionId}:${lectureId}`);
    if (quiz === undefined) return Promise.resolve(null);
    return Promise.resolve({
      revisionId,
      lectureId,
      passPct: quiz.passPct,
      questions: quiz.questions.map((q, position) => ({
        id: q.id,
        position,
        kind: q.kind,
        correct: q.options.flatMap((o, i) => (o.isCorrect ? [i] : [])),
        explanationMd: q.explanationMd,
      })),
    });
  }

  getCourseSummaries(courseIds: readonly string[], _ex?: Executor): Promise<CourseSummary[]> {
    return Promise.resolve(
      [...new Set(courseIds)].flatMap((id): CourseSummary[] => {
        const c = this.curricula.get(id);
        return c === undefined
          ? []
          : [
              {
                id: c.courseId,
                slug: c.slug,
                ownerId: c.ownerId,
                status: c.status,
                liveRevisionId: c.liveRevisionId,
                title: c.title,
                hasThumbnail: false,
              },
            ];
      }),
    );
  }

  asFacade(): CatalogFacade {
    return this as unknown as CatalogFacade;
  }
}

/** A revision's quiz with its key, as the fake catalog stores it. */
export interface FakeQuizContent {
  readonly passPct: number;
  readonly questions: readonly {
    readonly id: string;
    readonly kind: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE';
    readonly promptMd: string;
    readonly explanationMd: string | null;
    readonly options: readonly { readonly text: string; readonly isCorrect: boolean }[];
  }[];
}

export class FakeEnrollment {
  readonly active = new Set<string>([`${STUDENT}:${COURSE}`]);
  calls = 0;

  hasAccess(userId: string, courseId: string): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(this.active.has(`${userId}:${courseId}`));
  }

  asFacade(): EnrollmentFacade {
    return this as unknown as EnrollmentFacade;
  }
}

export class FakeUsers {
  readonly profiles = new Map<string, PublicProfile>();

  constructor() {
    this.profiles.set(OWNER, { id: OWNER, displayName: 'Ada Instructor' } as PublicProfile);
  }

  getPublicProfile(userId: string): Promise<PublicProfile | null> {
    return Promise.resolve(this.profiles.get(userId) ?? null);
  }

  asFacade(): UsersFacade {
    return this as unknown as UsersFacade;
  }
}

/** A clock tests move explicitly (no sleeping, no wall-clock bounds). */
export class FakeClock extends LearningClock {
  constructor(public ms = Date.UTC(2026, 9, 24, 12, 0, 0)) {
    super();
  }
  nowMs(): number {
    return this.ms;
  }
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

export class FakeTransactionRunner extends TransactionRunner {
  runs = 0;
  /** When set, the next `run` throws it after the work (a failed COMMIT). */
  failNextCommit: Error | null = null;

  async run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    this.runs += 1;
    const result = await work(FAKE_TRX);
    if (this.failNextCommit !== null) {
      const error = this.failNextCommit;
      this.failNextCommit = null;
      throw error;
    }
    return result;
  }
}

export interface RecordedEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export class RecordingEventPublisher extends LearningEventPublisher {
  readonly events: RecordedEvent[] = [];

  publish<TDef extends EventDefinition>(
    _trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly userId: string },
  ): Promise<void> {
    const parsed = event.safeParsePayload(payload);
    if (!parsed.success) throw new Error(`invalid ${event.qualifiedType} payload`);
    this.events.push({
      type: event.type,
      aggregateId: payload.userId,
      payload: payload as unknown as Record<string, unknown>,
    });
    return Promise.resolve();
  }

  ofType(type: string): RecordedEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

export class FakeRateLimiter extends LearningRateLimiter {
  readonly hits: { rule: LearningRateLimitName; subject: string }[] = [];
  limited = new Set<LearningRateLimitName>();

  hit(rule: LearningRateLimitName, subject: string): Promise<void> {
    this.hits.push({ rule, subject });
    if (this.limited.has(rule)) {
      return Promise.reject(new RateLimitedError('Too many requests.', { retryAfterMs: 30_000 }));
    }
    return Promise.resolve();
  }
}

export class FakeAccessCache extends AccessCache {
  readonly values = new Map<string, boolean>();

  get(userId: string, courseId: string): Promise<boolean | null> {
    return Promise.resolve(this.values.get(`${userId}:${courseId}`) ?? null);
  }
  set(userId: string, courseId: string, hasAccess: boolean): Promise<void> {
    this.values.set(`${userId}:${courseId}`, hasAccess);
    return Promise.resolve();
  }
}

interface StoredCompletion {
  readonly userId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly lectureType: LectureType;
  readonly cause: LectureCompletionCause;
  readonly completedAt: Date;
}

/** In-memory `lecture_completions` / `course_completions` / certificates (the §8.2 semantics). */
export class FakeLearningRepository extends LearningRepository {
  readonly completions = new Map<string, StoredCompletion>();
  readonly courseCompletions = new Map<string, { completedAt: Date; lectureCount: number }>();
  readonly certificates = new Map<string, CertificateRef>();
  locks = 0;

  constructor(private readonly clock: FakeClock) {
    super();
  }

  seedCompletion(
    userId: string,
    courseId: string,
    lectureId: string,
    lectureType: LectureType,
    cause: LectureCompletionCause,
  ): void {
    this.completions.set(`${userId}:${lectureId}`, {
      userId,
      courseId,
      lectureId,
      lectureType,
      cause,
      completedAt: new Date(this.clock.ms),
    });
  }

  recordCompletion(
    trx: Transaction<DB>,
    command: RecordCompletionCommand,
  ): Promise<RecordCompletionResult> {
    this.locks += 1;
    const key = `${command.userId}:${command.lectureId}`;
    let lectureCompletedAt: Date | null = null;
    if (!this.completions.has(key)) {
      lectureCompletedAt = new Date(this.clock.ms);
      this.completions.set(key, {
        userId: command.userId,
        courseId: command.courseId,
        lectureId: command.lectureId,
        lectureType: command.lectureType,
        cause: command.cause,
        completedAt: lectureCompletedAt,
      });
    }
    return this.evaluateCourseCompletion(trx, command).then((course) => ({
      lectureCompletedAt,
      course,
    }));
  }

  evaluateCourseCompletion(
    _trx: Transaction<DB>,
    input: { userId: string; courseId: string; liveLectureIds: readonly string[] },
  ): Promise<CourseCompletionEvaluation> {
    this.locks += 1;
    const ids = [...new Set(input.liveLectureIds)];
    const done = ids.filter((id) => this.completions.has(`${input.userId}:${id}`)).length;
    const key = `${input.userId}:${input.courseId}`;
    const prior = this.courseCompletions.get(key);
    if (done < ids.length || ids.length === 0) {
      return Promise.resolve({
        completedLectures: done,
        totalLectures: ids.length,
        completion:
          prior === undefined ? null : { completedAt: prior.completedAt, newlyCompleted: false },
      });
    }
    if (prior !== undefined) {
      return Promise.resolve({
        completedLectures: done,
        totalLectures: ids.length,
        completion: { completedAt: prior.completedAt, newlyCompleted: false },
      });
    }
    const completedAt = new Date(this.clock.ms);
    this.courseCompletions.set(key, { completedAt, lectureCount: ids.length });
    return Promise.resolve({
      completedLectures: done,
      totalLectures: ids.length,
      completion: { completedAt, newlyCompleted: true },
    });
  }

  clearCompletion(
    _trx: Transaction<DB>,
    input: { userId: string; courseId: string; lectureId: string },
  ): Promise<{ lectureType: LectureType } | null> {
    this.locks += 1;
    const key = `${input.userId}:${input.lectureId}`;
    const row = this.completions.get(key);
    if (row === undefined || row.courseId !== input.courseId) return Promise.resolve(null);
    this.completions.delete(key);
    return Promise.resolve({ lectureType: row.lectureType });
  }

  listCompletions(userId: string, courseId: string): Promise<LectureCompletionRecord[]> {
    return Promise.resolve(
      [...this.completions.values()]
        .filter((c) => c.userId === userId && c.courseId === courseId)
        .map((c) => ({ lectureId: c.lectureId, cause: c.cause, completedAt: c.completedAt })),
    );
  }

  listCompletedLectureIds(userId: string, courseId: string): Promise<string[]> {
    return this.listCompletions(userId, courseId).then((rows) => rows.map((r) => r.lectureId));
  }

  findCourseCompletion(userId: string, courseId: string): Promise<{ completedAt: Date } | null> {
    const row = this.courseCompletions.get(`${userId}:${courseId}`);
    return Promise.resolve(row === undefined ? null : { completedAt: row.completedAt });
  }

  findCertificate(userId: string, courseId: string): Promise<CertificateRef | null> {
    return Promise.resolve(this.certificates.get(`${userId}:${courseId}`) ?? null);
  }

  progressCounts(
    userId: string,
    courses: readonly { courseId: string; lectureIds: readonly string[] }[],
  ): Promise<Map<string, { completed: number; total: number }>> {
    return Promise.resolve(
      new Map(
        courses.map((c) => {
          const ids = [...new Set(c.lectureIds)];
          const completed = ids.filter((id) => this.completions.has(`${userId}:${id}`)).length;
          return [c.courseId, { completed, total: ids.length }];
        }),
      ),
    );
  }

  consumption(
    userId: string,
    courseId: string,
    lectures: readonly ConsumptionLecture[],
  ): Promise<ConsumptionFigures> {
    const completed = lectures.filter((l) => this.completions.has(`${userId}:${l.lectureId}`));
    const certificate = this.certificates.get(`${userId}:${courseId}`);
    return Promise.resolve({
      videoSecondsWatched: 0,
      videoSecondsTotal: lectures.reduce(
        (sum, l) => sum + (l.type === 'VIDEO' ? (l.durationSeconds ?? 0) : 0),
        0,
      ),
      completedLectures: completed.length,
      totalLectures: lectures.length,
      courseCompletedAt: this.courseCompletions.get(`${userId}:${courseId}`)?.completedAt ?? null,
      certificateStatus: (certificate?.status ?? null) as CertificateStatus | null,
    });
  }
}

/** In-memory `lecture_progress` / `course_activity` with the §8.1 merge rules. */
export class FakeProgressRepository extends ProgressRepository {
  readonly rows = new Map<string, ProgressRow>();
  readonly activities = new Map<string, ActivityRow>();
  lockHeld = false;
  /** Members whose write fails the next batch with a CHECK violation (dropped). */
  readonly rejectKeys = new Set<string>();
  /** When set, `writeBatch` throws it (a DB outage). */
  failWrites: Error | null = null;
  batches = 0;

  tryLockFlush(): Promise<boolean> {
    return Promise.resolve(!this.lockHeld);
  }

  writeBatch(
    _trx: Transaction<DB>,
    progress: readonly ProgressRow[],
    activity: readonly ActivityRow[],
  ): Promise<ProgressBatchResult> {
    this.batches += 1;
    if (this.failWrites !== null) return Promise.reject(this.failWrites);
    const dropped: string[] = [];
    let written = 0;
    for (const row of progress) {
      const key = `${row.userId}:${row.lectureId}`;
      if (this.rejectKeys.has(key)) {
        dropped.push(key);
        continue;
      }
      this.merge(row);
      written += 1;
    }
    for (const a of activity) this.mergeActivity(a);
    return Promise.resolve({ written, dropped });
  }

  writeOne(
    _trx: Transaction<DB>,
    row: ProgressRow,
    activity: ActivityRow,
  ): Promise<StoredProgress> {
    const merged = this.merge(row);
    this.mergeActivity(activity);
    return Promise.resolve(this.stateOf(merged));
  }

  writeActivity(_ex: Executor, activity: ActivityRow): Promise<void> {
    this.mergeActivity(activity);
    return Promise.resolve();
  }

  findCoverage(userId: string, lectureId: string): Promise<StoredCoverage | null> {
    const row = this.rows.get(`${userId}:${lectureId}`);
    return Promise.resolve(
      row === undefined
        ? null
        : {
            mediaAssetId: row.mediaAssetId,
            durationSeconds: row.durationSeconds,
            positionSeconds: row.positionSeconds,
            coverage: row.coverage,
            firstWatchedAt: row.firstWatchedAt,
            lastWatchedAt: row.lastWatchedAt,
          },
    );
  }

  listCourseProgress(
    userId: string,
    courseId: string,
  ): Promise<readonly (StoredProgress & { courseId: string })[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.userId === userId && r.courseId === courseId)
        .map((r) => ({ ...this.stateOf(r), courseId: r.courseId })),
    );
  }

  findActivity(
    userId: string,
    courseId: string,
  ): Promise<{ lectureId: string; accessedAt: Date } | null> {
    const a = this.activities.get(`${userId}:${courseId}`);
    return Promise.resolve(
      a === undefined ? null : { lectureId: a.lectureId, accessedAt: a.accessedAt },
    );
  }

  private merge(row: ProgressRow): ProgressRow {
    const key = `${row.userId}:${row.lectureId}`;
    const buckets = bucketCountOf(row.durationSeconds, 5);
    const incoming = CoverageBitmap.fromBytes(row.coverage, buckets);
    const current = this.rows.get(key);
    let next: ProgressRow;
    if (current === undefined) {
      next = { ...row, coverage: incoming.toBytes() };
    } else if (
      current.mediaAssetId === row.mediaAssetId &&
      current.durationSeconds === row.durationSeconds
    ) {
      const or = CoverageBitmap.fromBytes(current.coverage, buckets).toBytes();
      const inc = incoming.toBytes();
      for (let i = 0; i < or.length; i++) or[i]! |= inc[i] ?? 0;
      const newer = row.lastWatchedAt >= current.lastWatchedAt;
      next = {
        ...current,
        coverage: or,
        positionSeconds: newer ? row.positionSeconds : current.positionSeconds,
        firstWatchedAt:
          row.firstWatchedAt < current.firstWatchedAt ? row.firstWatchedAt : current.firstWatchedAt,
        lastWatchedAt: newer ? row.lastWatchedAt : current.lastWatchedAt,
      };
    } else if (row.lastWatchedAt >= current.lastWatchedAt) {
      next = { ...row, coverage: incoming.toBytes() };
    } else {
      next = current;
    }
    this.rows.set(key, next);
    return next;
  }

  private mergeActivity(a: ActivityRow): void {
    const key = `${a.userId}:${a.courseId}`;
    const current = this.activities.get(key);
    if (current === undefined || a.accessedAt > current.accessedAt) this.activities.set(key, a);
  }

  private stateOf(row: ProgressRow): StoredProgress {
    const buckets = bucketCountOf(row.durationSeconds, 5);
    return {
      userId: row.userId,
      lectureId: row.lectureId,
      mediaAssetId: row.mediaAssetId,
      durationSeconds: row.durationSeconds,
      positionSeconds: row.positionSeconds,
      coveredBuckets: CoverageBitmap.fromBytes(row.coverage, buckets).coveredBuckets(),
      bucketCount: buckets,
      lastWatchedAt: row.lastWatchedAt,
    };
  }
}

interface BufferedEntry {
  courseId: string;
  mediaAssetId: string;
  durationSeconds: number;
  positionSeconds: number;
  hbMs: number;
  firstMs: number;
  bitmap: CoverageBitmap;
}

/**
 * An in-memory model of the Redis write-behind buffer: the same plausibility and bucket rules
 * as `RedisProgressStore`, and the claim / processing-set / ack / re-queue protocol of
 * `RedisProgressFlushQueue`, so the use cases and the flush job are tested against the
 * protocol (the Lua itself is covered by the integration spec).
 */
export class FakeProgressBuffer extends ProgressStore {
  readonly entries = new Map<string, BufferedEntry>();
  readonly activity = new Map<string, { lectureId: string; atMs: number }>();
  /** member -> first-dirty ms */
  readonly dirty = new Map<string, number>();
  readonly processing = new Map<string, Map<string, number>>();
  readonly runs = new Map<string, number>();
  /** When set, `record` throws it (Redis down). */
  failRecord: Error | null = null;

  constructor(private readonly settings: LearningSettings) {
    super();
  }

  record(input: RecordProgressInput): Promise<RecordProgressResult> {
    if (this.failRecord !== null) return Promise.reject(this.failRecord);
    const key = `${input.userId}:${input.lectureId}`;
    const buckets = bucketCountOf(input.durationSeconds, this.settings.bucketSeconds);
    let entry = this.entries.get(key);
    const budget = plausibilityBudgetSeconds(
      entry?.hbMs ?? null,
      input.nowMs,
      this.settings.plausibility,
    );
    const { accepted, droppedSeconds } = acceptPlayedRanges(
      input.ranges,
      input.durationSeconds,
      budget,
    );
    if (
      entry === undefined ||
      entry.mediaAssetId !== input.mediaAssetId ||
      entry.durationSeconds !== input.durationSeconds
    ) {
      entry = {
        courseId: input.courseId,
        mediaAssetId: input.mediaAssetId,
        durationSeconds: input.durationSeconds,
        positionSeconds: 0,
        hbMs: input.nowMs,
        firstMs: input.nowMs,
        bitmap: CoverageBitmap.empty(buckets),
      };
    }
    entry.bitmap = entry.bitmap.withSpans(bucketSpansOf(accepted, this.settings.bucketSeconds));
    entry.positionSeconds = Math.min(Math.max(input.positionSeconds, 0), input.durationSeconds);
    entry.hbMs = Math.max(entry.hbMs, input.nowMs);
    this.entries.set(key, entry);
    if (!this.dirty.has(`p:${key}`)) this.dirty.set(`p:${key}`, input.nowMs);
    this.touch(input.userId, input.courseId, input.lectureId, input.nowMs);
    return Promise.resolve({
      coveredBuckets: entry.bitmap.coveredBuckets(),
      bucketCount: buckets,
      droppedSeconds,
    });
  }

  readBuffered(
    userId: string,
    lectures: readonly VideoLectureRef[],
  ): Promise<ReadonlyMap<string, LiveLectureProgress>> {
    const result = new Map<string, LiveLectureProgress>();
    for (const l of lectures) {
      const e = this.entries.get(`${userId}:${l.lectureId}`);
      if (
        e === undefined ||
        e.mediaAssetId !== l.mediaAssetId ||
        e.durationSeconds !== l.durationSeconds
      ) {
        continue;
      }
      result.set(l.lectureId, {
        positionSeconds: e.positionSeconds,
        coveredBuckets: e.bitmap.coveredBuckets(),
        bucketCount: e.bitmap.bucketCount,
      });
    }
    return Promise.resolve(result);
  }

  readBufferedActivity(
    userId: string,
    courseId: string,
  ): Promise<{ lectureId: string; atMs: number } | null> {
    return Promise.resolve(this.activity.get(`${userId}:${courseId}`) ?? null);
  }

  touchActivity(userId: string, courseId: string, lectureId: string, nowMs: number): Promise<void> {
    this.touch(userId, courseId, lectureId, nowMs);
    return Promise.resolve();
  }

  private touch(userId: string, courseId: string, lectureId: string, nowMs: number): void {
    const key = `${userId}:${courseId}`;
    const current = this.activity.get(key);
    if (current !== undefined && current.atMs > nowMs) return;
    this.activity.set(key, { lectureId, atMs: nowMs });
    if (!this.dirty.has(`a:${key}`)) this.dirty.set(`a:${key}`, nowMs);
  }

  /** The queue side of the same buffer. */
  queue(): FakeProgressFlushQueue {
    return new FakeProgressFlushQueue(this);
  }
}

export class FakeProgressFlushQueue extends ProgressFlushQueue {
  /** When set, the next `ack` throws it. */
  failAck: Error | null = null;
  /** When set, the next `requeue` throws it. */
  failRequeue: Error | null = null;
  readonly cutoffs: number[] = [];

  constructor(private readonly buffer: FakeProgressBuffer) {
    super();
  }

  claim(runId: string, limit: number, nowMs: number): Promise<ClaimedBatch> {
    const members = [...this.buffer.dirty.entries()].sort((a, b) => a[1] - b[1]).slice(0, limit);
    if (members.length === 0)
      return Promise.resolve({ claimed: 0, progress: [], activity: [], invalid: [] });
    const proc = new Map<string, number>();
    const progress: ProgressRow[] = [];
    const activity: ActivityRow[] = [];
    const invalid: string[] = [];
    for (const [member, score] of members) {
      this.buffer.dirty.delete(member);
      proc.set(member, score);
      const [kind, a, b] = member.split(':') as [string, string, string];
      if (kind === 'p') {
        const e = this.buffer.entries.get(`${a}:${b}`);
        if (e === undefined) {
          invalid.push(member);
          continue;
        }
        progress.push({
          userId: a,
          lectureId: b,
          courseId: e.courseId,
          mediaAssetId: e.mediaAssetId,
          durationSeconds: e.durationSeconds,
          positionSeconds: e.positionSeconds,
          coverage: e.bitmap.toBytes(),
          firstWatchedAt: new Date(e.firstMs),
          lastWatchedAt: new Date(e.hbMs),
        });
      } else {
        const act = this.buffer.activity.get(`${a}:${b}`);
        if (act === undefined) {
          invalid.push(member);
          continue;
        }
        activity.push({
          userId: a,
          courseId: b,
          lectureId: act.lectureId,
          accessedAt: new Date(act.atMs),
        });
      }
    }
    this.buffer.processing.set(runId, proc);
    this.buffer.runs.set(runId, nowMs);
    return Promise.resolve({ claimed: members.length, progress, activity, invalid });
  }

  ack(runId: string): Promise<void> {
    if (this.failAck !== null) {
      const error = this.failAck;
      this.failAck = null;
      return Promise.reject(error);
    }
    this.buffer.processing.delete(runId);
    this.buffer.runs.delete(runId);
    return Promise.resolve();
  }

  requeue(runId: string): Promise<number> {
    if (this.failRequeue !== null) {
      const error = this.failRequeue;
      this.failRequeue = null;
      return Promise.reject(error);
    }
    return Promise.resolve(this.requeueRun(runId));
  }

  recoverStale(cutoffMs: number): Promise<number> {
    this.cutoffs.push(cutoffMs);
    let moved = 0;
    for (const [runId, at] of [...this.buffer.runs]) {
      if (at <= cutoffMs) moved += this.requeueRun(runId);
    }
    return Promise.resolve(moved);
  }

  private requeueRun(runId: string): number {
    let moved = 0;
    for (const [member, score] of this.buffer.processing.get(runId) ?? []) {
      if (!this.buffer.dirty.has(member)) {
        this.buffer.dirty.set(member, score);
        moved += 1;
      }
    }
    this.buffer.processing.delete(runId);
    this.buffer.runs.delete(runId);
    return moved;
  }
}

export function testSettings(
  overrides: Partial<{
    progressStore: 'redis' | 'direct';
    jobsEnabled: boolean;
    flushIntervalMs: number;
    flushBatchSize: number;
    videoCompletePct: number;
  }> = {},
): LearningSettings {
  return new LearningSettings(
    overrides.progressStore ?? 'redis',
    overrides.jobsEnabled ?? true,
    overrides.flushIntervalMs ?? 15_000,
    overrides.flushBatchSize ?? 500,
    5,
    overrides.videoCompletePct ?? 90,
  );
}

/** Everything the learning use cases need, wired with fakes. */
export function learningHarness(
  options: { curriculum?: LiveCurriculum; settings?: LearningSettings } = {},
) {
  const settings = options.settings ?? testSettings();
  const clock = new FakeClock();
  const catalog = new FakeCatalog(options.curriculum);
  const enrollment = new FakeEnrollment();
  const users = new FakeUsers();
  const accessCache = new FakeAccessCache();
  const rateLimiter = new FakeRateLimiter();
  const events = new RecordingEventPublisher();
  const tx = new FakeTransactionRunner();
  const completions = new FakeLearningRepository(clock);
  const progressRepo = new FakeProgressRepository();
  const buffer = new FakeProgressBuffer(settings);
  const queue = buffer.queue();
  const access = new LearnerAccess(catalog.asFacade(), enrollment.asFacade(), accessCache);
  const recorder = new CompletionRecorder(completions, events);
  return {
    settings,
    clock,
    catalog,
    enrollment,
    users,
    accessCache,
    rateLimiter,
    events,
    tx,
    completions,
    progressRepo,
    buffer,
    queue,
    access,
    recorder,
    heartbeat: new RecordHeartbeatCommand(
      rateLimiter,
      access,
      buffer,
      completions,
      recorder,
      tx,
      clock,
      settings,
    ),
    complete: new CompleteLectureCommand(
      rateLimiter,
      access,
      recorder,
      completions,
      buffer,
      tx,
      clock,
    ),
    uncomplete: new UncompleteLectureCommand(rateLimiter, access, recorder, completions, tx, clock),
    bootstrap: new GetPlayerBootstrapQuery(
      access,
      users.asFacade(),
      completions,
      progressRepo,
      buffer,
      recorder,
      tx,
      settings,
    ),
    flushJob: new ProgressFlushJob(queue, progressRepo, tx, clock, settings),
    facade: new LearningFacade(catalog.asFacade(), completions),
    reader: new LearningProgressReader(catalog.asFacade(), completions),
  };
}

export type LearningHarness = ReturnType<typeof learningHarness>;
