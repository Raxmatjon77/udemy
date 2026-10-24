import type { ClientApp } from '../auth/client-app.js';
import { ErrorCode } from '../errors/error-code.js';
import type { LectureType, PersonRef } from '../http/catalog.js';
import {
  ANNOUNCEMENT_LIMITS,
  type Announcement,
  type AnnouncementQuota,
  WISHLIST_LIMITS,
  type WishlistItem,
  type WishlistState,
} from '../http/engagement-community.js';
import {
  AUTO_HIDE_REPORT_THRESHOLD,
  type ModerationAction,
  type ModerationActionType,
  type ModerationQueueItem,
  type ModerationStatus,
  type ModerationSubject,
  type Report,
  type ReportReason,
  type ReportStatus,
  type ReportSubjectType,
} from '../http/engagement-moderation.js';
import type {
  Answer,
  InstructorQaItem,
  InstructorQaStatus,
  Question,
  QaSort,
} from '../http/engagement-qa.js';
import {
  type CourseRating,
  type InstructorReview,
  type MyCourseReview,
  type MyReview,
  type PublicReview,
  type PublicReviewReply,
  ratingAverage,
  type RatingHistogram,
  type ReviewBlockReason,
  type ReviewReply,
  type ReviewState,
  ENGAGEMENT_RATE_LIMITS,
} from '../http/engagement-reviews.js';
import {
  type AdminCertificate,
  type Certificate,
  type CertificateTransition,
  type CertificateTransitionCause,
  type CertificateVerification,
  type ClientCompletionCause,
  type CompletionState,
  type CourseProgress,
  isCompletionCauseAllowed,
  LEARNING_LIMITS,
  LEARNING_PROGRESS_RULES,
  LEARNING_RATE_LIMITS,
  type LectureCompletionCause,
  type Note,
  type PlayedRange,
  type PlayerBootstrap,
  type PlayerLecture,
  type ProgressAck,
  progressPct,
  type QuizAnswer,
  type QuizAttempt,
  type QuizAttemptDetail,
  type QuizAttemptQuestion,
  type QuizAttemptStatus,
  type QuizAttemptSummary,
  type QuizResult,
  type SubmitQuizAttemptResponse,
} from '../http/learning.js';
import type { SignedUrl } from '../http/media.js';
import {
  NOTIFICATION_RATE_LIMITS,
  type Notification,
  type NotificationPreference,
  UNREAD_COUNT_CAP,
  type UnreadCount,
} from '../http/notifications.js';
import {
  isQuizQuestionComplete,
  QUIZ_LIMITS,
  type QuizAuthoring,
  type QuizQuestionAuthoring,
  type QuizQuestionKind,
  type RevisionQuiz,
} from '../http/quiz.js';
import {
  isPreferenceLocked,
  NOTIFICATION_APP_OF_CLIENT,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KIND_META,
  type NotificationApp,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationContent,
  NotificationContentSchema,
  type NotificationKind,
  type NotificationPayloadOf,
  type NotificationSubjectType,
  redactNotificationPayload,
} from '../notifications/notification-kinds.js';
import {
  REALTIME_LIMITS,
  realtimeCourseRoom,
  realtimeUserRoom,
  type RealtimeServerEvent,
  type RealtimeServerEventPayload,
  type RealtimeTicket,
} from '../realtime.js';
import { FIXTURE_IDS, fixtureFingerprint, fixtureId } from './fixtures.mjs';
import {
  defaultMockCurricula,
  type MockCurriculum,
  type MockLecture,
  type MockQuiz,
  type MockQuizQuestion,
} from './learning-fixtures.mjs';
import {
  type CommerceMockSeed,
  type CommerceMockStore,
  createCommerceMockStore,
  type MockCourse,
  MockApiError,
  type MockEnrollmentChange,
  type MockRateLimitRule,
} from './mock-store.mjs';

/**
 * An in-memory model of the Phase 5 api (learning, engagement, notifications, realtime tickets,
 * quiz authoring) behind `createLearningHandlers`. It builds on a `CommerceMockStore` for users,
 * courses, enrollments and the viewer, and plays the Phase 5 **workers synchronously**:
 * certificates are issued on course completion, ratings are recomputed at read time,
 * notifications are fanned out at once, enrollment revokes suspend reviews and revoke
 * certificates. Every response the handlers send is parsed with its contracts schema first.
 *
 * Modelled from the design: the learner access rule (404 → 403 `enrollment_required`, owner =
 * read-only PREVIEW), heartbeat coverage in 5 s buckets with the plausibility budget and the 90%
 * rule (D3, D4), completion causes per type, course completion (D5), the quiz reveal policy (Q5),
 * certificate revoke/reinstate (D7), review eligibility (D10), Q&A visibility, votes, accept,
 * auto-hide at 3 reports (D13), the announcement quota (D18), wishlist rules (D19), notification
 * preferences with locked categories, the unread cap and the realtime ticket. Rate limits are
 * fixed windows with 429 + `Retry-After` (`LEARNING_MOCK_RATE_LIMITS`, override with
 * `seed.rateLimits`); lists use the same opaque keyset cursor as the Phase 4 mocks.
 *
 * Realtime pushes are recorded in `store.realtimeEvents` (`{ room, event, payload }`); there is
 * no socket server. The viewer's app (`viewerApp`) decides which routes it may call, like the
 * effective permissions of the app's token (403 `forbidden` otherwise).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function ms(rule: { limit: number; windowSeconds: number }): MockRateLimitRule {
  return { limit: rule.limit, windowMs: rule.windowSeconds * 1000 };
}

/** The design §9 rules, from the contracts constants. */
export const LEARNING_MOCK_RATE_LIMITS = Object.freeze({
  heartbeat: ms(LEARNING_RATE_LIMITS.heartbeat),
  completionToggle: ms(LEARNING_RATE_LIMITS.completionToggle),
  noteWrite: ms(LEARNING_RATE_LIMITS.noteWrite),
  quizStart: ms(LEARNING_RATE_LIMITS.quizStart),
  quizSubmit: ms(LEARNING_RATE_LIMITS.quizSubmit),
  certificateVerify: ms(LEARNING_RATE_LIMITS.certificateVerify),
  reviewWrite: ms(ENGAGEMENT_RATE_LIMITS.reviewWrite),
  questionPost: ms(ENGAGEMENT_RATE_LIMITS.questionPost),
  answerPost: ms(ENGAGEMENT_RATE_LIMITS.answerPost),
  vote: ms(ENGAGEMENT_RATE_LIMITS.vote),
  report: ms(ENGAGEMENT_RATE_LIMITS.report),
  announcementPost: ms(ENGAGEMENT_RATE_LIMITS.announcementPost),
  wishlistWrite: ms(ENGAGEMENT_RATE_LIMITS.wishlistWrite),
  publicRead: ms(ENGAGEMENT_RATE_LIMITS.publicRead),
  unsubscribe: ms(NOTIFICATION_RATE_LIMITS.unsubscribe),
  realtimeTicket: ms(NOTIFICATION_RATE_LIMITS.realtimeTicket),
} satisfies Record<string, MockRateLimitRule>);
export type LearningMockRateLimitName = keyof typeof LEARNING_MOCK_RATE_LIMITS;

export interface LearningMockSeed {
  /** Users, courses, enrollments and the viewer; a fresh default store when omitted. */
  commerce?: CommerceMockStore;
  /** Used to create the commerce store when `commerce` is omitted. */
  commerceSeed?: CommerceMockSeed;
  /** The app of the viewer's token (BFF). Default `'student'`. */
  viewerApp?: ClientApp;
  /** Live curricula; default `defaultMockCurricula()`. */
  curricula?: MockCurriculum[];
  /** Admin user ids (receive MODERATION_QUEUE). Default `[FIXTURE_IDS.admin]`. */
  adminIds?: string[];
  /** Override some of `LEARNING_MOCK_RATE_LIMITS`. */
  rateLimits?: Partial<Record<LearningMockRateLimitName, MockRateLimitRule>>;
  /** `LEARNING_VIDEO_COMPLETE_RATIO`, default 0.9. */
  videoCompleteRatio?: number;
  /** `ENGAGEMENT_AUTO_HIDE_REPORTS`, default 3. */
  autoHideReports?: number;
  /** `immediate` (default): the issuer runs on completion; `manual`: call `issueCertificates()`. */
  certificateIssuance?: 'immediate' | 'manual';
  /** Issued certificates have a rendered PDF. Default true (false: the pdf routes are 409). */
  certificatePdfReady?: boolean;
  /** `REALTIME_PUBLIC_URL`. Default `http://127.0.0.1:3001`. */
  realtimeUrl?: string;
}

interface MockProgress {
  userId: string;
  courseId: string;
  lectureId: string;
  bucketCount: number;
  buckets: Set<number>;
  positionSeconds: number;
  lastHeartbeatAt: number | null;
}

interface MockCompletion {
  userId: string;
  courseId: string;
  lectureId: string;
  lectureType: LectureType;
  cause: LectureCompletionCause;
  revisionId: string;
  completedAt: string;
}

interface MockNote extends Note {
  userId: string;
}

interface MockAttempt {
  id: string;
  userId: string;
  courseId: string;
  lectureId: string;
  revisionId: string;
  status: QuizAttemptStatus;
  passPct: number;
  /** Snapshot of the revision's questions WITH the key (internal; never sent before submit). */
  questions: MockQuizQuestion[];
  startedAt: string;
  submittedAt: string | null;
  abandonedAt: string | null;
  result: QuizResult | null;
}

interface MockCertificate {
  id: string;
  code: string;
  userId: string;
  courseId: string;
  courseTitle: string;
  recipientName: string;
  instructorName: string;
  status: 'ACTIVE' | 'REVOKED';
  issuedAt: string;
  revokedAt: string | null;
  pdfReady: boolean;
  transitions: CertificateTransition[];
}

interface MockReply {
  authorId: string;
  body: string;
  moderation: ModerationStatus;
  createdAt: string;
  editedAt: string | null;
}

interface MockReview {
  id: string;
  courseId: string;
  userId: string;
  rating: number;
  body: string | null;
  moderation: ModerationStatus;
  suspendedAt: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  reply: MockReply | null;
}

interface MockQuestion {
  id: string;
  courseId: string;
  lectureId: string | null;
  authorId: string;
  title: string;
  bodyMd: string;
  acceptedAnswerId: string | null;
  moderation: ModerationStatus;
  votes: Set<string>;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  lastActivityAt: string;
}

interface MockAnswer {
  id: string;
  questionId: string;
  courseId: string;
  authorId: string;
  bodyMd: string;
  moderation: ModerationStatus;
  votes: Set<string>;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

interface MockAnnouncement {
  id: string;
  courseId: string;
  authorId: string;
  title: string;
  bodyMd: string;
  sendEmail: boolean;
  createdAt: string;
  deletedAt: string | null;
}

interface MockReport {
  id: string;
  subjectType: ReportSubjectType;
  subjectId: string;
  reporterId: string;
  reason: ReportReason;
  comment: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
}

interface MockNotification {
  id: string;
  userId: string;
  app: NotificationApp;
  content: NotificationContent;
  subjectType: NotificationSubjectType | null;
  subjectId: string | null;
  createdAt: string;
  readAt: string | null;
}

interface MockWorkingQuestion extends MockQuizQuestion {
  updatedAt: string;
}

interface MockWorkingQuiz {
  passPct: number;
  questions: MockWorkingQuestion[];
  updatedAt: string;
}

/** One realtime push the api or the worker would have emitted. */
export interface MockRealtimeEvent<E extends RealtimeServerEvent = RealtimeServerEvent> {
  room: string;
  event: E;
  payload: RealtimeServerEventPayload<E>;
}

/** What a report or a moderation action is about. */
interface MockSubject {
  type: ReportSubjectType;
  id: string;
  courseId: string;
  authorId: string;
  moderation: ModerationStatus;
  deleted: boolean;
  setModeration(status: ModerationStatus): void;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Newest first: (createdAt DESC, id DESC), the keyset order of most Phase 5 lists. */
function newestFirst<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function notFound(code: string): MockApiError {
  return new MockApiError(404, code);
}

function forbidden(code: string = ErrorCode.Forbidden): MockApiError {
  return new MockApiError(403, code);
}

export class LearningMockStore {
  readonly commerce: CommerceMockStore;
  viewerApp: ClientApp;
  /** False: `POST /realtime/tickets` is 503 `realtime_unavailable` (Redis down). */
  realtimeAvailable = true;
  readonly curricula = new Map<string, MockCurriculum>();
  readonly adminIds: string[];
  /** Every push, oldest first (clear it between steps if needed). */
  readonly realtimeEvents: MockRealtimeEvent[] = [];
  private readonly videoCompleteRatio: number;
  private readonly autoHideReports: number;
  private readonly certificateIssuance: 'immediate' | 'manual';
  private readonly certificatePdfReady: boolean;
  private readonly realtimeUrl: string;
  private readonly rateLimits: Record<LearningMockRateLimitName, MockRateLimitRule>;
  private readonly rateWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly progress = new Map<string, MockProgress>();
  private readonly completions = new Map<string, MockCompletion>();
  private readonly courseCompletions = new Map<
    string,
    { revisionId: string; lectureCount: number; completedAt: string }
  >();
  private readonly activity = new Map<string, { lectureId: string; at: string }>();
  private readonly pendingCertificates: { userId: string; courseId: string }[] = [];
  private readonly notes: MockNote[] = [];
  private readonly attempts: MockAttempt[] = [];
  private readonly certificates: MockCertificate[] = [];
  private readonly reviews: MockReview[] = [];
  private readonly questions: MockQuestion[] = [];
  private readonly answers: MockAnswer[] = [];
  private readonly announcements: MockAnnouncement[] = [];
  private readonly wishlists = new Map<string, { courseId: string; addedAt: string }[]>();
  private readonly reports: MockReport[] = [];
  private readonly moderationActions: ModerationAction[] = [];
  private readonly notifications: MockNotification[] = [];
  private readonly preferences = new Map<string, boolean>();
  private readonly workingQuizzes = new Map<string, MockWorkingQuiz>();
  private readonly courseVersions = new Map<string, number>();
  private seq = 0;

  constructor(seed: LearningMockSeed = {}) {
    this.commerce = seed.commerce ?? createCommerceMockStore(seed.commerceSeed);
    this.viewerApp = seed.viewerApp ?? 'student';
    this.adminIds = seed.adminIds ?? [FIXTURE_IDS.admin];
    this.videoCompleteRatio = seed.videoCompleteRatio ?? LEARNING_PROGRESS_RULES.videoCompleteRatio;
    this.autoHideReports = seed.autoHideReports ?? AUTO_HIDE_REPORT_THRESHOLD;
    this.certificateIssuance = seed.certificateIssuance ?? 'immediate';
    this.certificatePdfReady = seed.certificatePdfReady ?? true;
    this.realtimeUrl = seed.realtimeUrl ?? 'http://127.0.0.1:3001';
    this.rateLimits = { ...LEARNING_MOCK_RATE_LIMITS, ...seed.rateLimits };
    for (const curriculum of seed.curricula ?? defaultMockCurricula()) {
      this.curricula.set(curriculum.courseId, curriculum);
    }
    this.commerce.setCourseProgressReader((userId, courseId) =>
      this.curricula.has(courseId) ? this.courseProgress(userId, courseId).pct : null,
    );
    this.commerce.onEnrollmentChange((change) => this.onEnrollmentChange(change));
  }

  /* ================================================================ helpers */

  get viewerId(): string {
    return this.commerce.viewerId;
  }

  private nowMs(): number {
    return this.commerce.currentTime().getTime();
  }

  private iso(offsetMs = 0): string {
    return new Date(this.nowMs() + offsetMs).toISOString();
  }

  private nextId(): string {
    this.seq += 1;
    return fixtureId(0x500000000 + this.seq);
  }

  /** Counts one request against `name` for `key`; 429 `rate_limited` + `Retry-After` when over. */
  hitRateLimit(name: LearningMockRateLimitName, key: string = this.viewerId): void {
    const rule = this.rateLimits[name];
    const now = this.nowMs();
    const bucket = `${name}:${key}`;
    let window = this.rateWindows.get(bucket);
    if (!window || now - window.startedAt >= rule.windowMs) {
      window = { startedAt: now, count: 0 };
      this.rateWindows.set(bucket, window);
    }
    window.count += 1;
    if (window.count > rule.limit) {
      const retryAfter = Math.max(1, Math.ceil((window.startedAt + rule.windowMs - now) / 1000));
      throw new MockApiError(429, ErrorCode.RateLimited, {}, { 'retry-after': String(retryAfter) });
    }
  }

  /** The route needs a permission only these apps' tokens carry (403 `forbidden`). */
  requireApp(...apps: ClientApp[]): void {
    if (!apps.includes(this.viewerApp)) throw forbidden();
  }

  private get viewerAudience(): NotificationApp {
    return NOTIFICATION_APP_OF_CLIENT[this.viewerApp];
  }

  private person(userId: string): PersonRef | null {
    const user = this.commerce.users.get(userId);
    return user && !user.banned ? { id: user.id, displayName: user.displayName } : null;
  }

  /** Admin views show actors even when banned. */
  private actor(userId: string | null): PersonRef | null {
    const user = userId === null ? undefined : this.commerce.users.get(userId);
    return user ? { id: user.id, displayName: user.displayName } : null;
  }

  private nameOf(userId: string): string {
    return this.commerce.users.get(userId)?.displayName ?? 'Former student';
  }

  private courseOf(courseId: string): MockCourse | undefined {
    return this.commerce.courses.get(courseId);
  }

  /** The live curriculum of a PUBLISHED or ARCHIVED course (404 `course_not_found`). */
  private liveCourse(courseId: string): { course: MockCourse; curriculum: MockCurriculum } {
    const course = this.courseOf(courseId);
    const curriculum = this.curricula.get(courseId);
    if (!course || !curriculum || (course.status !== 'PUBLISHED' && course.status !== 'ARCHIVED')) {
      throw notFound(ErrorCode.CourseNotFound);
    }
    return { course, curriculum };
  }

  private liveLectures(curriculum: MockCurriculum): MockLecture[] {
    return curriculum.sections.flatMap((s) => s.lectures);
  }

  private liveLecture(curriculum: MockCurriculum, lectureId: string): MockLecture {
    const lecture = this.liveLectures(curriculum).find((l) => l.id === lectureId);
    if (!lecture) throw notFound(ErrorCode.LectureNotFound);
    return lecture;
  }

  private isOwner(courseId: string, userId = this.viewerId): boolean {
    return this.courseOf(courseId)?.ownerId === userId;
  }

  /** The common learner rule (§5): 404 first, then the ACTIVE enrollment (or the owner preview). */
  private learnerMode(courseId: string): 'LEARNER' | 'PREVIEW' {
    this.requireApp('student');
    this.liveCourse(courseId);
    if (this.commerce.hasActiveEnrollment(this.viewerId, courseId)) return 'LEARNER';
    if (this.isOwner(courseId)) return 'PREVIEW';
    throw forbidden(ErrorCode.EnrollmentRequired);
  }

  /** Learner writes: the owner preview is read-only. */
  private requireLearner(courseId: string): void {
    if (this.learnerMode(courseId) !== 'LEARNER') throw forbidden(ErrorCode.EnrollmentRequired);
  }

  /** Q&A: an ACTIVE learner or the owner; an instructor-app token only on owned courses. */
  private requireQaAccess(courseId: string): void {
    this.requireApp('student', 'instructor');
    this.liveCourse(courseId);
    if (this.isOwner(courseId)) return;
    if (
      this.viewerApp === 'student' &&
      this.commerce.hasActiveEnrollment(this.viewerId, courseId)
    ) {
      return;
    }
    throw forbidden(ErrorCode.EnrollmentRequired);
  }

  private canSeeQa(courseId: string, userId: string): boolean {
    return this.isOwner(courseId, userId) || this.commerce.hasActiveEnrollment(userId, courseId);
  }

  /** The instructor's own course in the instructor app (404 `course_not_found` otherwise). */
  private ownedCourse(courseId: string): MockCourse {
    this.requireApp('instructor');
    const course = this.courseOf(courseId);
    if (!course || course.ownerId !== this.viewerId) throw notFound(ErrorCode.CourseNotFound);
    return course;
  }

  private emit<E extends RealtimeServerEvent>(
    room: string,
    event: E,
    payload: RealtimeServerEventPayload<E>,
  ): void {
    this.realtimeEvents.push({ room, event, payload } as unknown as MockRealtimeEvent);
  }

  private signedUrl(key: string): SignedUrl {
    return {
      url: `https://media.test/${key}?X-Amz-Signature=mock`,
      expiresAt: this.iso(15 * 60 * 1000),
    };
  }

  /* ================================================================ learning: progress */

  private key(userId: string, id: string): string {
    return `${userId}:${id}`;
  }

  /** ⌊completed ∩ live / live × 100⌋ (D5). */
  courseProgress(userId: string, courseId: string): CourseProgress {
    const curriculum = this.curricula.get(courseId);
    const lectures = curriculum ? this.liveLectures(curriculum) : [];
    const completed = lectures.filter((l) => this.completions.has(this.key(userId, l.id))).length;
    return { completed, total: lectures.length, pct: progressPct(completed, lectures.length) };
  }

  private coverage(p: MockProgress | undefined): number {
    return p ? p.buckets.size / p.bucketCount : 0;
  }

  private completeInternal(
    userId: string,
    curriculum: MockCurriculum,
    lecture: MockLecture,
    cause: LectureCompletionCause,
  ): void {
    const k = this.key(userId, lecture.id);
    if (!this.completions.has(k)) {
      this.completions.set(k, {
        userId,
        courseId: curriculum.courseId,
        lectureId: lecture.id,
        lectureType: lecture.type,
        cause,
        revisionId: curriculum.liveRevisionId,
        completedAt: this.iso(),
      });
    }
    this.evaluateCourseCompletion(userId, curriculum);
  }

  /** `EvaluateCourseCompletion`: completed ⊇ live ids for the first time → completion + issuer. */
  private evaluateCourseCompletion(userId: string, curriculum: MockCurriculum): void {
    const k = this.key(userId, curriculum.courseId);
    if (this.courseCompletions.has(k)) return;
    const lectures = this.liveLectures(curriculum);
    if (lectures.length === 0) return;
    if (!lectures.every((l) => this.completions.has(this.key(userId, l.id)))) return;
    this.courseCompletions.set(k, {
      revisionId: curriculum.liveRevisionId,
      lectureCount: lectures.length,
      completedAt: this.iso(),
    });
    this.pendingCertificates.push({ userId, courseId: curriculum.courseId });
    if (this.certificateIssuance === 'immediate') this.issueCertificates();
  }

  private lectureView(userId: string | null, lecture: MockLecture): PlayerLecture {
    const completion =
      userId === null ? undefined : this.completions.get(this.key(userId, lecture.id));
    const p = userId === null ? undefined : this.progress.get(this.key(userId, lecture.id));
    return {
      id: lecture.id,
      type: lecture.type,
      title: lecture.title,
      durationSeconds: lecture.type === 'VIDEO' ? lecture.durationSeconds : null,
      isPreview: lecture.isPreview ?? false,
      quiz:
        lecture.type === 'QUIZ' && lecture.quiz
          ? { passPct: lecture.quiz.passPct, questionCount: lecture.quiz.questions.length }
          : null,
      completed: completion !== undefined,
      completedAt: completion?.completedAt ?? null,
      positionSeconds: p ? p.positionSeconds : null,
      coveragePct: p ? Math.floor(this.coverage(p) * 100) : null,
    };
  }

  /** `GET /me/courses/:courseId/learn`. */
  playerBootstrap(courseId: string): PlayerBootstrap {
    const mode = this.learnerMode(courseId);
    const { course, curriculum } = this.liveCourse(courseId);
    const learner = mode === 'LEARNER' ? this.viewerId : null;
    if (learner !== null) this.evaluateCourseCompletion(learner, curriculum);
    const lectures = this.liveLectures(curriculum);
    const progress =
      learner === null
        ? { completed: 0, total: lectures.length, pct: 0 }
        : this.courseProgress(learner, courseId);
    const completion =
      learner === null ? undefined : this.courseCompletions.get(this.key(learner, courseId));
    let resume: PlayerBootstrap['resume'] = null;
    if (learner !== null && lectures.length > 0) {
      const last = this.activity.get(this.key(learner, courseId));
      const lectureId =
        last && lectures.some((l) => l.id === last.lectureId)
          ? last.lectureId
          : (lectures.find((l) => !this.completions.has(this.key(learner, l.id))) ?? lectures[0])!
              .id;
      resume = {
        lectureId,
        positionSeconds: this.progress.get(this.key(learner, lectureId))?.positionSeconds ?? null,
      };
    }
    const certificate =
      learner === null
        ? undefined
        : this.certificates.find((c) => c.userId === learner && c.courseId === courseId);
    return {
      courseId,
      slug: course.slug,
      title: course.title,
      status: course.status === 'ARCHIVED' ? 'ARCHIVED' : 'PUBLISHED',
      liveRevisionId: curriculum.liveRevisionId,
      mode,
      instructor: this.person(course.ownerId),
      sections: curriculum.sections.map((s) => ({
        id: s.id,
        title: s.title,
        lectures: s.lectures.map((l) => this.lectureView(learner, l)),
      })),
      progress,
      resume,
      completedAt: completion?.completedAt ?? null,
      newContent: completion !== undefined && progress.pct < 100,
      certificate: certificate
        ? { id: certificate.id, code: certificate.code, status: certificate.status }
        : null,
    };
  }

  private ack(userId: string, courseId: string, lectureId: string): ProgressAck {
    return {
      lectureCompleted: this.completions.has(this.key(userId, lectureId)),
      courseCompleted: this.courseCompletions.has(this.key(userId, courseId)),
      coursePct: this.courseProgress(userId, courseId).pct,
    };
  }

  /** `PUT …/progress`: merges played ranges into 5 s buckets within the plausibility budget. */
  recordHeartbeat(
    courseId: string,
    lectureId: string,
    input: { positionSeconds: number; ranges: readonly PlayedRange[] },
  ): ProgressAck {
    this.hitRateLimit('heartbeat');
    this.requireLearner(courseId);
    const { curriculum } = this.liveCourse(courseId);
    const lecture = this.liveLecture(curriculum, lectureId);
    const duration = lecture.durationSeconds;
    if (lecture.type !== 'VIDEO' || duration === null || duration <= 0) {
      throw new MockApiError(422, ErrorCode.LectureTypeMismatch);
    }
    const userId = this.viewerId;
    const k = this.key(userId, lectureId);
    const bucketSeconds = LEARNING_PROGRESS_RULES.bucketSeconds;
    let p = this.progress.get(k);
    if (!p) {
      p = {
        userId,
        courseId,
        lectureId,
        bucketCount: Math.ceil(duration / bucketSeconds),
        buckets: new Set(),
        positionSeconds: 0,
        lastHeartbeatAt: null,
      };
      this.progress.set(k, p);
    }
    const now = this.nowMs();
    const budget =
      p.lastHeartbeatAt === null
        ? LEARNING_PROGRESS_RULES.plausibilityFirstSeconds
        : ((now - p.lastHeartbeatAt) / 1000) * LEARNING_PROGRESS_RULES.plausibilityFactor +
          LEARNING_PROGRESS_RULES.plausibilitySlackSeconds;
    // keep the newest ranges that fit the budget; drop the excess
    let spent = 0;
    for (const range of [...input.ranges].reverse()) {
      const from = Math.min(range.from, duration);
      const to = Math.min(range.to, duration);
      if (to <= from) continue;
      if (spent + (to - from) > budget) break;
      spent += to - from;
      for (
        let b = Math.floor(from / bucketSeconds);
        b <= Math.floor((to - 1) / bucketSeconds);
        b++
      ) {
        p.buckets.add(b);
      }
    }
    p.positionSeconds = Math.min(input.positionSeconds, duration);
    p.lastHeartbeatAt = now;
    this.activity.set(this.key(userId, courseId), { lectureId, at: this.iso() });
    if (this.coverage(p) >= this.videoCompleteRatio) {
      this.completeInternal(userId, curriculum, lecture, 'VIDEO_WATCHED');
    }
    return this.ack(userId, courseId, lectureId);
  }

  private completionState(userId: string, courseId: string, lectureId: string): CompletionState {
    const completion = this.completions.get(this.key(userId, lectureId));
    return {
      lectureId,
      completed: completion !== undefined,
      cause: completion?.cause ?? null,
      completedAt: completion?.completedAt ?? null,
      progress: this.courseProgress(userId, courseId),
      courseCompletedAt:
        this.courseCompletions.get(this.key(userId, courseId))?.completedAt ?? null,
    };
  }

  /** `POST …/completion`: ARTICLE/RESOURCE only, with a cause that matches the type. */
  completeLecture(
    courseId: string,
    lectureId: string,
    cause: ClientCompletionCause,
  ): CompletionState {
    this.hitRateLimit('completionToggle');
    this.requireLearner(courseId);
    const { curriculum } = this.liveCourse(courseId);
    const lecture = this.liveLecture(curriculum, lectureId);
    if (!isCompletionCauseAllowed(lecture.type, cause)) {
      throw new MockApiError(422, ErrorCode.CompletionNotAllowed);
    }
    this.activity.set(this.key(this.viewerId, courseId), { lectureId, at: this.iso() });
    this.completeInternal(this.viewerId, curriculum, lecture, cause);
    return this.completionState(this.viewerId, courseId, lectureId);
  }

  /** `DELETE …/completion`: idempotent; never touches the course completion or a certificate. */
  uncompleteLecture(courseId: string, lectureId: string): CompletionState {
    this.hitRateLimit('completionToggle');
    this.requireLearner(courseId);
    const { curriculum } = this.liveCourse(courseId);
    this.liveLecture(curriculum, lectureId);
    this.completions.delete(this.key(this.viewerId, lectureId));
    return this.completionState(this.viewerId, courseId, lectureId);
  }

  /** Test helper: mark lectures complete for a user (as if they did the work). */
  seedCompletion(userId: string, courseId: string, lectureIds?: readonly string[]): void {
    const curriculum = this.curricula.get(courseId);
    if (!curriculum) throw notFound(ErrorCode.CourseNotFound);
    for (const lecture of this.liveLectures(curriculum)) {
      if (lectureIds && !lectureIds.includes(lecture.id)) continue;
      const cause = (
        ['VIDEO_WATCHED', 'ARTICLE_READ', 'RESOURCE_OPENED', 'QUIZ_PASSED'] as const
      ).find((c) => isCompletionCauseAllowed(lecture.type, c))!;
      this.completeInternal(userId, curriculum, lecture, cause);
    }
  }

  /* ================================================================ learning: notes */

  private noteView(note: MockNote): Note {
    return {
      id: note.id,
      courseId: note.courseId,
      lectureId: note.lectureId,
      positionSeconds: note.positionSeconds,
      bodyMd: note.bodyMd,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }

  listNotes(courseId: string, lectureId?: string): Note[] {
    this.requireLearner(courseId);
    return this.notes
      .filter(
        (n) =>
          n.userId === this.viewerId &&
          n.courseId === courseId &&
          (lectureId === undefined || n.lectureId === lectureId),
      )
      .sort(newestFirst)
      .map((n) => this.noteView(n));
  }

  private checkNotePosition(
    lecture: MockLecture,
    positionSeconds: number | null | undefined,
  ): void {
    if (positionSeconds === null || positionSeconds === undefined) return;
    if (
      lecture.type !== 'VIDEO' ||
      lecture.durationSeconds === null ||
      positionSeconds > lecture.durationSeconds
    ) {
      throw new MockApiError(422, ErrorCode.ValidationFailed, {
        errors: [{ path: 'positionSeconds', message: 'Only within the duration of a video' }],
      });
    }
  }

  createNote(
    courseId: string,
    input: { lectureId: string; positionSeconds?: number | undefined; bodyMd: string },
  ): Note {
    this.hitRateLimit('noteWrite');
    this.requireLearner(courseId);
    const { curriculum } = this.liveCourse(courseId);
    const lecture = this.liveLecture(curriculum, input.lectureId);
    this.checkNotePosition(lecture, input.positionSeconds);
    const count = this.notes.filter(
      (n) => n.userId === this.viewerId && n.courseId === courseId,
    ).length;
    if (count >= LEARNING_LIMITS.maxNotesPerCourse) {
      throw new MockApiError(422, ErrorCode.NoteLimitExceeded);
    }
    const at = this.iso();
    const note: MockNote = {
      id: this.nextId(),
      userId: this.viewerId,
      courseId,
      lectureId: lecture.id,
      positionSeconds: input.positionSeconds ?? null,
      bodyMd: input.bodyMd,
      createdAt: at,
      updatedAt: at,
    };
    this.notes.push(note);
    return this.noteView(note);
  }

  /** Own notes stay editable after a revoke (D9): no enrollment check. */
  private ownNote(noteId: string): MockNote {
    this.requireApp('student');
    const note = this.notes.find((n) => n.id === noteId && n.userId === this.viewerId);
    if (!note) throw notFound(ErrorCode.NoteNotFound);
    return note;
  }

  updateNote(
    noteId: string,
    input: { bodyMd?: string | undefined; positionSeconds?: number | null | undefined },
  ): Note {
    this.hitRateLimit('noteWrite');
    const note = this.ownNote(noteId);
    if (input.positionSeconds !== undefined) {
      const curriculum = this.curricula.get(note.courseId);
      const lecture =
        curriculum && this.liveLectures(curriculum).find((l) => l.id === note.lectureId);
      if (input.positionSeconds !== null && !lecture) {
        throw new MockApiError(422, ErrorCode.ValidationFailed);
      }
      if (lecture) this.checkNotePosition(lecture, input.positionSeconds);
      note.positionSeconds = input.positionSeconds;
    }
    if (input.bodyMd !== undefined) note.bodyMd = input.bodyMd;
    note.updatedAt = this.iso();
    return this.noteView(note);
  }

  deleteNote(noteId: string): void {
    this.hitRateLimit('noteWrite');
    const note = this.ownNote(noteId);
    this.notes.splice(this.notes.indexOf(note), 1);
  }

  /* ================================================================ learning: quiz attempts */

  private attemptQuestions(attempt: MockAttempt): QuizAttemptQuestion[] {
    return attempt.questions.map((q, position) => ({
      id: q.id,
      position,
      kind: q.kind,
      promptMd: q.promptMd,
      options: q.options.map((o, i) => ({ position: i, text: o.text })),
    }));
  }

  private attemptView(attempt: MockAttempt): QuizAttempt {
    return {
      id: attempt.id,
      courseId: attempt.courseId,
      lectureId: attempt.lectureId,
      revisionId: attempt.revisionId,
      status: attempt.status,
      passPct: attempt.passPct,
      questionCount: attempt.questions.length,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      abandonedAt: attempt.abandonedAt,
      questions: this.attemptQuestions(attempt),
    };
  }

  /** `POST …/quiz-attempts`: `{ status: 201 | 200, attempt }` (200 = the open attempt). */
  startQuizAttempt(
    courseId: string,
    lectureId: string,
  ): { status: 200 | 201; attempt: QuizAttempt } {
    this.hitRateLimit('quizStart');
    this.requireLearner(courseId);
    const { curriculum } = this.liveCourse(courseId);
    const lecture = this.liveLecture(curriculum, lectureId);
    if (lecture.type !== 'QUIZ' || !lecture.quiz || lecture.quiz.questions.length === 0) {
      throw new MockApiError(422, ErrorCode.LectureTypeMismatch);
    }
    const open = this.attempts.find(
      (a) => a.userId === this.viewerId && a.lectureId === lectureId && a.status === 'IN_PROGRESS',
    );
    if (open && open.revisionId === curriculum.liveRevisionId) {
      return { status: 200, attempt: this.attemptView(open) };
    }
    if (open) {
      open.status = 'ABANDONED';
      open.abandonedAt = this.iso();
    }
    const attempt: MockAttempt = {
      id: this.nextId(),
      userId: this.viewerId,
      courseId,
      lectureId,
      revisionId: curriculum.liveRevisionId,
      status: 'IN_PROGRESS',
      passPct: lecture.quiz.passPct,
      questions: structuredClone(lecture.quiz.questions),
      startedAt: this.iso(),
      submittedAt: null,
      abandonedAt: null,
      result: null,
    };
    this.attempts.push(attempt);
    return { status: 201, attempt: this.attemptView(attempt) };
  }

  listQuizAttempts(courseId: string, lectureId: string): QuizAttemptSummary[] {
    this.requireLearner(courseId);
    const { curriculum } = this.liveCourse(courseId);
    this.liveLecture(curriculum, lectureId);
    return this.attempts
      .filter((a) => a.userId === this.viewerId && a.lectureId === lectureId)
      .map((a) => ({ ...a, createdAt: a.startedAt }))
      .sort(newestFirst)
      .map((a) => ({
        id: a.id,
        lectureId: a.lectureId,
        revisionId: a.revisionId,
        status: a.status,
        scorePct: a.result?.scorePct ?? null,
        passed: a.result?.passed ?? null,
        startedAt: a.startedAt,
        submittedAt: a.submittedAt,
      }));
  }

  private ownAttempt(attemptId: string): MockAttempt {
    this.requireApp('student');
    const attempt = this.attempts.find((a) => a.id === attemptId && a.userId === this.viewerId);
    if (!attempt) throw notFound(ErrorCode.QuizAttemptNotFound);
    return attempt;
  }

  getQuizAttempt(attemptId: string): QuizAttemptDetail {
    const attempt = this.ownAttempt(attemptId);
    return { ...this.attemptView(attempt), result: attempt.result };
  }

  /** Grades against the attempt's revision key; a pass completes the lecture (QUIZ_PASSED). */
  submitQuizAttempt(attemptId: string, answers: readonly QuizAnswer[]): SubmitQuizAttemptResponse {
    this.hitRateLimit('quizSubmit');
    const attempt = this.ownAttempt(attemptId);
    if (attempt.status === 'ABANDONED') {
      throw new MockApiError(409, ErrorCode.AttemptNotInProgress);
    }
    if (attempt.status === 'IN_PROGRESS') {
      const byId = new Map(attempt.questions.map((q) => [q.id, q]));
      for (const answer of answers) {
        const question = byId.get(answer.questionId);
        if (
          !question ||
          answer.optionPositions.some((p) => p >= question.options.length) ||
          (question.kind === 'SINGLE_CHOICE' && answer.optionPositions.length > 1)
        ) {
          throw new MockApiError(422, ErrorCode.QuizAnswersInvalid);
        }
      }
      const selected = new Map(answers.map((a) => [a.questionId, [...a.optionPositions].sort()]));
      const graded = attempt.questions.map((q, position) => {
        const correct = q.options.flatMap((o, i) => (o.isCorrect ? [i] : []));
        const mine = selected.get(q.id) ?? [];
        return { q, position, correct, mine, ok: mine.length > 0 && sameSet(mine, correct) };
      });
      const correctCount = graded.filter((g) => g.ok).length;
      const scorePct = Math.round((correctCount / graded.length) * 100);
      const passed = scorePct >= attempt.passPct;
      const revealed = passed;
      attempt.status = 'SUBMITTED';
      attempt.submittedAt = this.iso();
      attempt.result = {
        attemptId: attempt.id,
        courseId: attempt.courseId,
        lectureId: attempt.lectureId,
        scorePct,
        correctCount,
        questionCount: graded.length,
        passPct: attempt.passPct,
        passed,
        revealed,
        submittedAt: attempt.submittedAt,
        questions: graded.map((g) => ({
          questionId: g.q.id,
          position: g.position,
          selectedOptions: g.mine,
          yourAnswerCorrect: g.ok,
          correctOptions: revealed ? g.correct : null,
          explanationMd: revealed ? g.q.explanationMd : null,
        })),
      };
      const curriculum = this.curricula.get(attempt.courseId);
      const lecture =
        curriculum && this.liveLectures(curriculum).find((l) => l.id === attempt.lectureId);
      if (passed && curriculum && lecture) {
        this.completeInternal(this.viewerId, curriculum, lecture, 'QUIZ_PASSED');
      }
    }
    return {
      ...attempt.result!,
      progress: this.ack(this.viewerId, attempt.courseId, attempt.lectureId),
    };
  }

  /** `LearningMaintenanceJob`: abandon IN_PROGRESS attempts older than the TTL. */
  abandonStaleAttempts(): number {
    const cutoff = this.nowMs() - LEARNING_LIMITS.quizAttemptTtlHours * HOUR_MS;
    let count = 0;
    for (const attempt of this.attempts) {
      if (attempt.status === 'IN_PROGRESS' && Date.parse(attempt.startedAt) < cutoff) {
        attempt.status = 'ABANDONED';
        attempt.abandonedAt = this.iso();
        count += 1;
      }
    }
    return count;
  }

  /* ================================================================ learning: certificates */

  private certificateCode(): string {
    let n = 0x5ce7 + this.seq * 7919;
    let code = '';
    for (let i = 0; i < 26; i++) {
      code += CROCKFORD[(n + i * 13) % 32];
      n = Math.floor(n / 3) + 17;
    }
    return code;
  }

  /** The issuer worker: runs the pending `CourseCompleted` (immediately by default). */
  issueCertificates(): Certificate[] {
    const issued: Certificate[] = [];
    for (const { userId, courseId } of this.pendingCertificates.splice(0)) {
      if (this.certificates.some((c) => c.userId === userId && c.courseId === courseId)) continue;
      const course = this.courseOf(courseId);
      if (!course) continue;
      this.seq += 1;
      const at = this.iso();
      const certificate: MockCertificate = {
        id: this.nextId(),
        code: this.certificateCode(),
        userId,
        courseId,
        courseTitle: course.title,
        recipientName: this.nameOf(userId),
        instructorName: this.nameOf(course.ownerId),
        status: 'ACTIVE',
        issuedAt: at,
        revokedAt: null,
        pdfReady: this.certificatePdfReady,
        transitions: [],
      };
      certificate.transitions.push({
        id: this.nextId(),
        action: 'ISSUE',
        cause: 'COURSE_COMPLETED',
        actorId: null,
        actor: null,
        reason: null,
        occurredAt: at,
      });
      this.certificates.push(certificate);
      this.notify(
        userId,
        'STUDENT',
        'CERTIFICATE_ISSUED',
        {
          certificateId: certificate.id,
          code: certificate.code,
          courseId,
          courseTitle: course.title,
        },
        { type: 'CERTIFICATE', id: certificate.id },
      );
      issued.push(this.certificateView(certificate));
    }
    return issued;
  }

  /** Test helper: the PDF finished rendering (pdf routes stop answering 409). */
  markCertificatePdfReady(certificateId: string): void {
    const certificate = this.certificates.find((c) => c.id === certificateId);
    if (!certificate) throw notFound(ErrorCode.CertificateNotFound);
    certificate.pdfReady = true;
  }

  private certificateView(c: MockCertificate): Certificate {
    return {
      id: c.id,
      code: c.code,
      courseId: c.courseId,
      courseSlug: this.courseOf(c.courseId)?.slug ?? null,
      courseTitle: c.courseTitle,
      recipientName: c.recipientName,
      instructorName: c.instructorName,
      status: c.status,
      issuedAt: c.issuedAt,
      revokedAt: c.revokedAt,
      pdfReady: c.pdfReady,
    };
  }

  myCertificates(): Certificate[] {
    this.requireApp('student');
    return this.certificates
      .filter((c) => c.userId === this.viewerId)
      .map((c) => ({ ...c, createdAt: c.issuedAt }))
      .sort(newestFirst)
      .map((c) => this.certificateView(c));
  }

  private ownCertificate(certificateId: string): MockCertificate {
    this.requireApp('student');
    const c = this.certificates.find((x) => x.id === certificateId && x.userId === this.viewerId);
    if (!c) throw notFound(ErrorCode.CertificateNotFound);
    return c;
  }

  myCertificate(certificateId: string): Certificate {
    return this.certificateView(this.ownCertificate(certificateId));
  }

  myCertificatePdf(certificateId: string): SignedUrl {
    const c = this.ownCertificate(certificateId);
    if (!c.pdfReady) throw new MockApiError(409, ErrorCode.CertificatePdfPending);
    return this.signedUrl(`certificates/${c.id}/v1.pdf`);
  }

  private byCode(code: string): MockCertificate {
    this.hitRateLimit('certificateVerify', 'ip');
    const c = this.certificates.find((x) => x.code === code);
    if (!c) throw notFound(ErrorCode.CertificateNotFound);
    return c;
  }

  /** Public verification. */
  verifyCertificate(code: string): CertificateVerification {
    const c = this.byCode(code);
    const course = this.courseOf(c.courseId);
    return {
      code: c.code,
      status: c.status,
      recipientName: c.recipientName,
      courseTitle: c.courseTitle,
      instructorName: c.instructorName,
      issuedAt: c.issuedAt,
      revokedAt: c.revokedAt,
      courseSlug: course && course.status === 'PUBLISHED' ? course.slug : null,
      pdfAvailable: c.status === 'ACTIVE' && c.pdfReady,
    };
  }

  /** Public PDF: ACTIVE only (a revoked one is 404), 409 while rendering. */
  publicCertificatePdf(code: string): SignedUrl {
    const c = this.byCode(code);
    if (c.status !== 'ACTIVE') throw notFound(ErrorCode.CertificateNotFound);
    if (!c.pdfReady) throw new MockApiError(409, ErrorCode.CertificatePdfPending);
    return this.signedUrl(`certificates/${c.id}/v1.pdf`);
  }

  private transitionCertificate(
    c: MockCertificate,
    to: 'ACTIVE' | 'REVOKED',
    cause: CertificateTransitionCause,
    actorId: string | null,
    reason: string | null,
  ): void {
    const at = this.iso();
    c.status = to;
    c.revokedAt = to === 'REVOKED' ? at : null;
    c.transitions.push({
      id: this.nextId(),
      action: to === 'REVOKED' ? 'REVOKE' : 'REINSTATE',
      cause,
      actorId,
      actor: this.actor(actorId),
      reason,
      occurredAt: at,
    });
  }

  private adminCertificateView(c: MockCertificate): AdminCertificate {
    return {
      certificate: this.certificateView(c),
      userId: c.userId,
      transitions: [...c.transitions],
    };
  }

  adminUserCertificates(userId: string): AdminCertificate[] {
    this.requireApp('admin');
    if (!this.commerce.users.has(userId)) throw notFound(ErrorCode.UserNotFound);
    return this.certificates
      .filter((c) => c.userId === userId)
      .map((c) => this.adminCertificateView(c));
  }

  adminTransitionCertificate(
    certificateId: string,
    action: 'revoke' | 'reinstate',
    reason: string,
  ): AdminCertificate {
    this.requireApp('admin');
    const c = this.certificates.find((x) => x.id === certificateId);
    if (!c) throw notFound(ErrorCode.CertificateNotFound);
    const to = action === 'revoke' ? 'REVOKED' : 'ACTIVE';
    if (c.status === to) throw new MockApiError(409, ErrorCode.InvalidStateTransition);
    this.transitionCertificate(c, to, 'ADMIN', this.viewerId, reason);
    return this.adminCertificateView(c);
  }

  /** The certificate revoker and review-enrollment sync workers (D7, D9). */
  private onEnrollmentChange(change: MockEnrollmentChange): void {
    const certificate = this.certificates.find(
      (c) => c.userId === change.userId && c.courseId === change.courseId,
    );
    const review = this.reviews.find(
      (r) => r.userId === change.userId && r.courseId === change.courseId && r.deletedAt === null,
    );
    if (change.kind === 'REVOKED') {
      if (certificate?.status === 'ACTIVE') {
        this.transitionCertificate(certificate, 'REVOKED', 'ENROLLMENT_REVOKED', null, null);
      }
      if (review) review.suspendedAt = this.iso();
    } else if (change.kind === 'REGRANTED') {
      // An admin revocation sticks: a regrant only undoes a revocation the enrollment caused.
      const lastRevoke = certificate?.transitions.findLast((t) => t.action === 'REVOKE');
      if (
        certificate?.status === 'REVOKED' &&
        lastRevoke?.cause !== 'ADMIN' &&
        this.courseCompletions.has(this.key(change.userId, change.courseId))
      ) {
        this.transitionCertificate(certificate, 'ACTIVE', 'ENROLLMENT_REGRANTED', null, null);
      }
      if (review) review.suspendedAt = null;
    }
  }

  /* ================================================================ engagement: reviews */

  private reviewState(r: MockReview): ReviewState {
    if (r.suspendedAt !== null) return 'SUSPENDED';
    return r.moderation === 'HIDDEN' ? 'HIDDEN' : 'PUBLISHED';
  }

  private isPublic(r: MockReview): boolean {
    return r.deletedAt === null && this.reviewState(r) === 'PUBLISHED';
  }

  private publicReply(reply: MockReply | null): PublicReviewReply | null {
    if (!reply || reply.moderation !== 'VISIBLE') return null;
    return {
      body: reply.body,
      author: this.person(reply.authorId),
      createdAt: reply.createdAt,
      editedAt: reply.editedAt,
    };
  }

  /** Ratings are recomputed at read time here (the api's read model is eventually consistent). */
  ratings(courseIds: readonly string[]): CourseRating[] {
    this.hitRateLimit('publicRead', 'ip');
    return courseIds.map((courseId) => {
      const histogram: RatingHistogram = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
      for (const r of this.reviews) {
        if (r.courseId === courseId && this.isPublic(r)) {
          const bucket = `${r.rating}` as keyof RatingHistogram;
          histogram[bucket] += 1;
        }
      }
      const count = Object.values(histogram).reduce((sum, n) => sum + n, 0);
      return { courseId, average: ratingAverage(histogram), count, histogram };
    });
  }

  publicReviews(courseId: string, rating?: number): PublicReview[] {
    this.hitRateLimit('publicRead', 'ip');
    this.liveCourse(courseId);
    return this.reviews
      .filter(
        (r) =>
          r.courseId === courseId &&
          this.isPublic(r) &&
          (rating === undefined || r.rating === rating),
      )
      .sort(newestFirst)
      .map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        author: this.person(r.userId),
        createdAt: r.createdAt,
        editedAt: r.editedAt,
        reply: this.publicReply(r.reply),
      }));
  }

  private myLiveReview(courseId: string): MockReview | undefined {
    return this.reviews.find(
      (r) => r.courseId === courseId && r.userId === this.viewerId && r.deletedAt === null,
    );
  }

  private myReviewView(r: MockReview): MyReview {
    return {
      id: r.id,
      courseId: r.courseId,
      rating: r.rating,
      body: r.body,
      state: this.reviewState(r),
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      reply: this.publicReply(r.reply),
    };
  }

  /** D10, in order: the owner, an ACTIVE enrollment, at least one completed live lecture. */
  private reviewBlock(courseId: string): ReviewBlockReason | null {
    if (this.isOwner(courseId)) return ErrorCode.CannotReviewOwnCourse;
    if (!this.commerce.hasActiveEnrollment(this.viewerId, courseId)) {
      return ErrorCode.EnrollmentRequired;
    }
    if (this.courseProgress(this.viewerId, courseId).completed < 1) {
      return ErrorCode.ReviewNotEligible;
    }
    return null;
  }

  myCourseReview(courseId: string): MyCourseReview {
    this.requireApp('student');
    this.liveCourse(courseId);
    const review = this.myLiveReview(courseId);
    const blockReason = this.reviewBlock(courseId);
    return {
      courseId,
      review: review ? this.myReviewView(review) : null,
      canReview: blockReason === null,
      blockReason,
    };
  }

  upsertMyReview(
    courseId: string,
    input: { rating: number; body?: string | null | undefined },
  ): { status: 200 | 201; review: MyReview } {
    this.hitRateLimit('reviewWrite');
    this.requireApp('student');
    const { course } = this.liveCourse(courseId);
    const block = this.reviewBlock(courseId);
    if (block === ErrorCode.ReviewNotEligible) throw new MockApiError(422, block);
    if (block !== null) throw forbidden(block);
    const body = input.body ?? null;
    const existing = this.myLiveReview(courseId);
    const at = this.iso();
    if (existing) {
      if (existing.rating !== input.rating || existing.body !== body) {
        const previous = existing.rating;
        existing.rating = input.rating;
        existing.body = body;
        existing.editedAt = at;
        if (previous !== input.rating) this.notifyReview(course, existing, previous);
      }
      return { status: 200, review: this.myReviewView(existing) };
    }
    const review: MockReview = {
      id: this.nextId(),
      courseId,
      userId: this.viewerId,
      rating: input.rating,
      body,
      moderation: 'VISIBLE',
      suspendedAt: null,
      createdAt: at,
      editedAt: null,
      deletedAt: null,
      reply: null,
    };
    this.reviews.push(review);
    this.notifyReview(course, review, null);
    return { status: 201, review: this.myReviewView(review) };
  }

  private notifyReview(
    course: MockCourse,
    review: MockReview,
    previousRating: number | null,
  ): void {
    this.notify(
      course.ownerId,
      'INSTRUCTOR',
      'REVIEW_NEW',
      {
        reviewId: review.id,
        courseId: course.id,
        courseTitle: course.title,
        rating: review.rating,
        previousRating,
        reviewerName: this.person(review.userId)?.displayName ?? null,
        excerpt: review.body === null ? null : review.body.slice(0, 280),
        redacted: false,
      },
      { type: 'REVIEW', id: review.id },
    );
  }

  deleteMyReview(courseId: string): void {
    this.requireApp('student');
    this.liveCourse(courseId);
    const review = this.myLiveReview(courseId);
    if (!review) throw notFound(ErrorCode.ReviewNotFound);
    review.deletedAt = this.iso();
  }

  private replyView(reviewId: string, reply: MockReply): ReviewReply {
    return {
      reviewId,
      body: reply.body,
      author: this.person(reply.authorId),
      hidden: reply.moderation === 'HIDDEN',
      createdAt: reply.createdAt,
      editedAt: reply.editedAt,
    };
  }

  instructorReviews(courseId: string, rating?: number): InstructorReview[] {
    this.ownedCourse(courseId);
    return this.reviews
      .filter(
        (r) =>
          r.courseId === courseId &&
          r.deletedAt === null &&
          (rating === undefined || r.rating === rating),
      )
      .sort(newestFirst)
      .map((r) => ({
        id: r.id,
        courseId,
        rating: r.rating,
        body: r.body,
        author: this.person(r.userId),
        state: this.reviewState(r),
        createdAt: r.createdAt,
        editedAt: r.editedAt,
        reply: r.reply ? this.replyView(r.id, r.reply) : null,
      }));
  }

  /** The review must be in this course and PUBLISHED or HIDDEN. */
  private repliableReview(courseId: string, reviewId: string): MockReview {
    const course = this.ownedCourse(courseId);
    const review = this.reviews.find(
      (r) => r.id === reviewId && r.courseId === course.id && r.deletedAt === null,
    );
    if (!review || review.suspendedAt !== null) throw notFound(ErrorCode.ReviewNotFound);
    return review;
  }

  upsertReviewReply(courseId: string, reviewId: string, body: string): ReviewReply {
    const review = this.repliableReview(courseId, reviewId);
    const at = this.iso();
    if (review.reply) {
      if (review.reply.body !== body) {
        review.reply.body = body;
        review.reply.editedAt = at;
      }
    } else {
      review.reply = {
        authorId: this.viewerId,
        body,
        moderation: 'VISIBLE',
        createdAt: at,
        editedAt: null,
      };
      const course = this.courseOf(courseId)!;
      this.notify(
        review.userId,
        'STUDENT',
        'REVIEW_REPLY',
        {
          reviewId: review.id,
          courseId,
          courseTitle: course.title,
          instructorName: this.person(this.viewerId)?.displayName ?? null,
          excerpt: body.slice(0, 280),
          redacted: false,
        },
        { type: 'REVIEW_REPLY', id: review.id },
      );
    }
    return this.replyView(review.id, review.reply);
  }

  deleteReviewReply(courseId: string, reviewId: string): void {
    const review = this.repliableReview(courseId, reviewId);
    if (!review.reply) throw notFound(ErrorCode.ReplyNotFound);
    review.reply = null;
  }

  /** Test helper: a review by any user (bypasses eligibility). */
  seedReview(userId: string, courseId: string, rating: number, body: string | null = null): string {
    const review: MockReview = {
      id: this.nextId(),
      courseId,
      userId,
      rating,
      body,
      moderation: 'VISIBLE',
      suspendedAt: null,
      createdAt: this.iso(),
      editedAt: null,
      deletedAt: null,
      reply: null,
    };
    this.reviews.push(review);
    return review.id;
  }

  /* ================================================================ engagement: Q&A */

  /** Hidden content is visible to its author only (admins use the moderation routes). */
  private questionVisible(q: MockQuestion): boolean {
    return q.moderation === 'VISIBLE' || q.authorId === this.viewerId;
  }

  private answerVisible(a: MockAnswer): boolean {
    return a.deletedAt === null && (a.moderation === 'VISIBLE' || a.authorId === this.viewerId);
  }

  private publicAnswers(questionId: string): MockAnswer[] {
    return this.answers.filter(
      (a) => a.questionId === questionId && a.deletedAt === null && a.moderation === 'VISIBLE',
    );
  }

  private questionView(q: MockQuestion): Question {
    const deleted = q.deletedAt !== null;
    return {
      id: q.id,
      courseId: q.courseId,
      lectureId: q.lectureId,
      title: deleted ? null : q.title,
      bodyMd: deleted ? null : q.bodyMd,
      author: deleted ? null : this.person(q.authorId),
      byInstructor: this.isOwner(q.courseId, q.authorId),
      mine: q.authorId === this.viewerId,
      upvoteCount: q.votes.size,
      answerCount: this.publicAnswers(q.id).length,
      acceptedAnswerId: q.acceptedAnswerId,
      resolved: q.acceptedAnswerId !== null,
      voted: q.votes.has(this.viewerId),
      hidden: q.moderation === 'HIDDEN',
      deleted,
      createdAt: q.createdAt,
      editedAt: q.editedAt,
      lastActivityAt: q.lastActivityAt,
    };
  }

  private answerView(a: MockAnswer, question: MockQuestion): Answer {
    return {
      id: a.id,
      questionId: a.questionId,
      bodyMd: a.deletedAt === null ? a.bodyMd : null,
      author: this.person(a.authorId),
      byInstructor: this.isOwner(a.courseId, a.authorId),
      mine: a.authorId === this.viewerId,
      upvoteCount: a.votes.size,
      voted: a.votes.has(this.viewerId),
      accepted: question.acceptedAnswerId === a.id,
      hidden: a.moderation === 'HIDDEN',
      deleted: a.deletedAt !== null,
      createdAt: a.createdAt,
      editedAt: a.editedAt,
    };
  }

  listQuestions(
    courseId: string,
    query: { lectureId?: string | undefined; sort: QaSort; q?: string | undefined },
  ): Question[] {
    this.requireQaAccess(courseId);
    const needle = query.q?.toLowerCase();
    const items = this.questions.filter(
      (q) =>
        q.courseId === courseId &&
        q.deletedAt === null &&
        this.questionVisible(q) &&
        (query.lectureId === undefined || q.lectureId === query.lectureId) &&
        (needle === undefined || q.title.toLowerCase().includes(needle)) &&
        (query.sort !== 'unanswered' || this.publicAnswers(q.id).length === 0),
    );
    const byId = (a: MockQuestion, b: MockQuestion) => (a.id < b.id ? 1 : -1);
    items.sort((a, b) => {
      if (query.sort === 'top' && a.votes.size !== b.votes.size) return b.votes.size - a.votes.size;
      if (query.sort === 'recent' && a.lastActivityAt !== b.lastActivityAt) {
        return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
      }
      if (query.sort === 'unanswered' && a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return byId(a, b);
    });
    return items.map((q) => this.questionView(q));
  }

  /** A visible question of this course (a deleted one with answers keeps its placeholder). */
  private findQuestion(courseId: string, questionId: string): MockQuestion {
    const q = this.questions.find((x) => x.id === questionId && x.courseId === courseId);
    if (
      !q ||
      !this.questionVisible(q) ||
      (q.deletedAt !== null && this.publicAnswers(q.id).length === 0)
    ) {
      throw notFound(ErrorCode.QuestionNotFound);
    }
    return q;
  }

  private openQuestion(courseId: string, questionId: string): MockQuestion {
    const q = this.findQuestion(courseId, questionId);
    if (q.deletedAt !== null) throw notFound(ErrorCode.QuestionNotFound);
    return q;
  }

  question(courseId: string, questionId: string): Question {
    this.requireQaAccess(courseId);
    return this.questionView(this.findQuestion(courseId, questionId));
  }

  listAnswers(courseId: string, questionId: string): Answer[] {
    this.requireQaAccess(courseId);
    const q = this.findQuestion(courseId, questionId);
    return this.answers
      .filter((a) => a.questionId === q.id && this.answerVisible(a))
      .sort((a, b) =>
        a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
      )
      .map((a) => this.answerView(a, q));
  }

  private qaChanged(q: MockQuestion): void {
    this.emit(realtimeCourseRoom(q.courseId), 'qa.changed', {
      courseId: q.courseId,
      questionId: q.id,
      lectureId: q.lectureId,
    });
  }

  askQuestion(
    courseId: string,
    input: { lectureId?: string | null | undefined; title: string; bodyMd: string },
  ): Question {
    this.hitRateLimit('questionPost');
    this.requireQaAccess(courseId);
    const { course, curriculum } = this.liveCourse(courseId);
    const lectureId = input.lectureId ?? null;
    if (lectureId !== null) this.liveLecture(curriculum, lectureId);
    const at = this.iso();
    const q: MockQuestion = {
      id: this.nextId(),
      courseId,
      lectureId,
      authorId: this.viewerId,
      title: input.title,
      bodyMd: input.bodyMd,
      acceptedAnswerId: null,
      moderation: 'VISIBLE',
      votes: new Set(),
      createdAt: at,
      editedAt: null,
      deletedAt: null,
      lastActivityAt: at,
    };
    this.questions.push(q);
    if (course.ownerId !== this.viewerId) {
      this.notify(
        course.ownerId,
        'INSTRUCTOR',
        'QA_NEW_QUESTION',
        {
          questionId: q.id,
          courseId,
          courseTitle: course.title,
          lectureId,
          questionTitle: q.title,
          authorName: this.person(q.authorId)?.displayName ?? null,
          redacted: false,
        },
        { type: 'QUESTION', id: q.id },
      );
    }
    this.qaChanged(q);
    return this.questionView(q);
  }

  editQuestion(
    courseId: string,
    questionId: string,
    input: { title?: string | undefined; bodyMd?: string | undefined },
  ): Question {
    this.requireQaAccess(courseId);
    const q = this.openQuestion(courseId, questionId);
    if (q.authorId !== this.viewerId) throw forbidden(ErrorCode.NotContentAuthor);
    if (input.title !== undefined) q.title = input.title;
    if (input.bodyMd !== undefined) q.bodyMd = input.bodyMd;
    q.editedAt = this.iso();
    this.qaChanged(q);
    return this.questionView(q);
  }

  deleteQuestion(courseId: string, questionId: string): void {
    this.requireQaAccess(courseId);
    const q = this.openQuestion(courseId, questionId);
    if (q.authorId !== this.viewerId) throw forbidden(ErrorCode.NotContentAuthor);
    q.deletedAt = this.iso();
    this.qaChanged(q);
  }

  postAnswer(courseId: string, questionId: string, bodyMd: string): Answer {
    this.hitRateLimit('answerPost');
    this.requireQaAccess(courseId);
    const q = this.openQuestion(courseId, questionId);
    if (q.moderation !== 'VISIBLE') throw notFound(ErrorCode.QuestionNotFound);
    const course = this.courseOf(courseId)!;
    const at = this.iso();
    const a: MockAnswer = {
      id: this.nextId(),
      questionId: q.id,
      courseId,
      authorId: this.viewerId,
      bodyMd,
      moderation: 'VISIBLE',
      votes: new Set(),
      createdAt: at,
      editedAt: null,
      deletedAt: null,
    };
    this.answers.push(a);
    q.lastActivityAt = at;
    if (q.authorId !== this.viewerId) {
      const byInstructor = course.ownerId === this.viewerId;
      this.notify(
        q.authorId,
        q.authorId === course.ownerId ? 'INSTRUCTOR' : 'STUDENT',
        'QA_NEW_ANSWER',
        {
          questionId: q.id,
          answerId: a.id,
          courseId,
          courseTitle: course.title,
          questionTitle: q.title,
          authorName: this.person(a.authorId)?.displayName ?? null,
          byInstructor,
          excerpt: bodyMd.slice(0, 280),
          redacted: false,
        },
        { type: 'ANSWER', id: a.id },
      );
    }
    this.qaChanged(q);
    return this.answerView(a, q);
  }

  private ownAnswer(courseId: string, answerId: string): { a: MockAnswer; q: MockQuestion } {
    this.requireQaAccess(courseId);
    const a = this.answers.find((x) => x.id === answerId && x.courseId === courseId);
    if (!a || !this.answerVisible(a)) throw notFound(ErrorCode.AnswerNotFound);
    if (a.authorId !== this.viewerId) throw forbidden(ErrorCode.NotContentAuthor);
    return { a, q: this.questions.find((x) => x.id === a.questionId)! };
  }

  editAnswer(courseId: string, answerId: string, bodyMd: string): Answer {
    const { a, q } = this.ownAnswer(courseId, answerId);
    a.bodyMd = bodyMd;
    a.editedAt = this.iso();
    this.qaChanged(q);
    return this.answerView(a, q);
  }

  deleteAnswer(courseId: string, answerId: string): void {
    const { a, q } = this.ownAnswer(courseId, answerId);
    a.deletedAt = this.iso();
    if (q.acceptedAnswerId === a.id) q.acceptedAnswerId = null;
    this.qaChanged(q);
  }

  /** PUT/DELETE vote on a question or an answer (204; idempotent; not your own). */
  vote(courseId: string, subject: 'question' | 'answer', id: string, on: boolean): void {
    if (on) this.hitRateLimit('vote');
    this.requireQaAccess(courseId);
    let votes: Set<string>;
    let authorId: string;
    if (subject === 'question') {
      const q = this.openQuestion(courseId, id);
      votes = q.votes;
      authorId = q.authorId;
    } else {
      const a = this.answers.find((x) => x.id === id && x.courseId === courseId);
      if (!a || !this.answerVisible(a)) throw notFound(ErrorCode.AnswerNotFound);
      votes = a.votes;
      authorId = a.authorId;
    }
    if (authorId === this.viewerId) throw new MockApiError(422, ErrorCode.CannotVoteOwnContent);
    if (on) votes.add(this.viewerId);
    else votes.delete(this.viewerId);
  }

  setAcceptedAnswer(courseId: string, questionId: string, answerId: string | null): Question {
    this.requireQaAccess(courseId);
    const q = this.openQuestion(courseId, questionId);
    const course = this.courseOf(courseId)!;
    if (q.authorId !== this.viewerId && course.ownerId !== this.viewerId) {
      throw forbidden(ErrorCode.NotContentAuthor);
    }
    if (answerId === null) {
      q.acceptedAnswerId = null;
    } else {
      const a = this.publicAnswers(q.id).find((x) => x.id === answerId);
      if (!a) throw notFound(ErrorCode.AnswerNotFound);
      if (q.acceptedAnswerId !== a.id && a.authorId !== this.viewerId) {
        this.notify(
          a.authorId,
          a.authorId === course.ownerId ? 'INSTRUCTOR' : 'STUDENT',
          'QA_RESOLVED',
          {
            questionId: q.id,
            answerId: a.id,
            courseId,
            courseTitle: course.title,
            questionTitle: q.title,
            redacted: false,
          },
          { type: 'QUESTION', id: q.id },
        );
      }
      q.acceptedAnswerId = a.id;
    }
    this.qaChanged(q);
    return this.questionView(q);
  }

  /** `GET /instructor/qa`: questions of the viewer's own courses. */
  instructorQa(query: {
    courseId?: string | undefined;
    status: InstructorQaStatus;
  }): InstructorQaItem[] {
    this.requireApp('instructor');
    if (query.courseId !== undefined) this.ownedCourse(query.courseId);
    return this.questions
      .filter((q) => {
        const course = this.courseOf(q.courseId);
        if (!course || course.ownerId !== this.viewerId) return false;
        if (query.courseId !== undefined && q.courseId !== query.courseId) return false;
        if (q.deletedAt !== null || q.moderation !== 'VISIBLE') return false;
        if (query.status === 'unanswered') return this.publicAnswers(q.id).length === 0;
        if (query.status === 'unresolved') return q.acceptedAnswerId === null;
        return true;
      })
      .sort((a, b) =>
        a.lastActivityAt === b.lastActivityAt
          ? a.id < b.id
            ? 1
            : -1
          : a.lastActivityAt < b.lastActivityAt
            ? 1
            : -1,
      )
      .map((q) => {
        const course = this.courseOf(q.courseId)!;
        const curriculum = this.curricula.get(q.courseId);
        const lecture =
          q.lectureId === null || !curriculum
            ? undefined
            : this.liveLectures(curriculum).find((l) => l.id === q.lectureId);
        return {
          question: this.questionView(q),
          course: { id: course.id, slug: course.slug, title: course.title },
          lectureTitle: lecture?.title ?? null,
        };
      });
  }

  /* ================================================================ engagement: announcements */

  private announcementView(a: MockAnnouncement): Announcement {
    return {
      id: a.id,
      courseId: a.courseId,
      title: a.title,
      bodyMd: a.bodyMd,
      author: this.person(a.authorId),
      sendEmail: a.sendEmail,
      createdAt: a.createdAt,
    };
  }

  private liveAnnouncements(courseId: string): Announcement[] {
    return this.announcements
      .filter((a) => a.courseId === courseId && a.deletedAt === null)
      .sort(newestFirst)
      .map((a) => this.announcementView(a));
  }

  /** Learner (or owner preview) list. */
  learnerAnnouncements(courseId: string): Announcement[] {
    this.learnerMode(courseId);
    return this.liveAnnouncements(courseId);
  }

  announcementQuota(courseId: string): AnnouncementQuota {
    const windowMs = ANNOUNCEMENT_LIMITS.windowDays * DAY_MS;
    const since = this.nowMs() - windowMs;
    const counted = this.announcements
      .filter((a) => a.courseId === courseId && Date.parse(a.createdAt) > since)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const full = counted.length >= ANNOUNCEMENT_LIMITS.perCourse;
    return {
      limit: ANNOUNCEMENT_LIMITS.perCourse,
      used: counted.length,
      windowDays: ANNOUNCEMENT_LIMITS.windowDays,
      nextAvailableAt: full
        ? new Date(
            Date.parse(counted[counted.length - ANNOUNCEMENT_LIMITS.perCourse]!.createdAt) +
              windowMs,
          ).toISOString()
        : null,
    };
  }

  instructorAnnouncements(courseId: string): Announcement[] {
    this.ownedCourse(courseId);
    return this.liveAnnouncements(courseId);
  }

  postAnnouncement(
    courseId: string,
    input: { title: string; bodyMd: string; sendEmail: boolean },
  ): Announcement {
    const course = this.ownedCourse(courseId);
    this.hitRateLimit('announcementPost');
    if (course.status !== 'PUBLISHED' && course.status !== 'ARCHIVED') {
      throw notFound(ErrorCode.CourseNotFound);
    }
    const quota = this.announcementQuota(courseId);
    if (quota.nextAvailableAt !== null) {
      throw new MockApiError(422, ErrorCode.AnnouncementLimitExceeded, {
        retryAt: quota.nextAvailableAt,
      });
    }
    const a: MockAnnouncement = {
      id: this.nextId(),
      courseId,
      authorId: this.viewerId,
      title: input.title,
      bodyMd: input.bodyMd,
      sendEmail: input.sendEmail,
      createdAt: this.iso(),
      deletedAt: null,
    };
    this.announcements.push(a);
    for (const userId of this.commerce.activeEnrolleeIds(courseId)) {
      this.notify(
        userId,
        'STUDENT',
        'ANNOUNCEMENT',
        {
          announcementId: a.id,
          courseId,
          courseTitle: course.title,
          title: a.title,
          authorName: this.person(a.authorId)?.displayName ?? null,
          redacted: false,
        },
        { type: 'ANNOUNCEMENT', id: a.id },
      );
    }
    return this.announcementView(a);
  }

  deleteAnnouncement(courseId: string, announcementId: string): void {
    this.ownedCourse(courseId);
    const a = this.announcements.find(
      (x) => x.id === announcementId && x.courseId === courseId && x.deletedAt === null,
    );
    if (!a) throw notFound(ErrorCode.AnnouncementNotFound);
    a.deletedAt = this.iso();
    this.redact('ANNOUNCEMENT', a.id);
  }

  /* ================================================================ engagement: wishlist */

  private wishlistOf(userId: string): { courseId: string; addedAt: string }[] {
    let list = this.wishlists.get(userId);
    if (!list) {
      list = [];
      this.wishlists.set(userId, list);
    }
    return list;
  }

  wishlist(): WishlistItem[] {
    this.requireApp('student');
    return this.wishlistOf(this.viewerId)
      .map((w) => ({ ...w, id: w.courseId, createdAt: w.addedAt }))
      .sort(newestFirst)
      .flatMap((w) => {
        const course = this.courseOf(w.courseId);
        if (!course) return [];
        return [
          {
            courseId: course.id,
            slug: course.slug,
            title: course.title,
            instructor: this.person(course.ownerId),
            hasThumbnail: course.hasThumbnail ?? false,
            available: course.status === 'PUBLISHED',
            addedAt: w.addedAt,
          },
        ];
      });
  }

  addToWishlist(courseId: string): void {
    this.hitRateLimit('wishlistWrite');
    this.requireApp('student');
    const course = this.courseOf(courseId);
    if (!course) throw notFound(ErrorCode.CourseNotFound);
    const list = this.wishlistOf(this.viewerId);
    if (list.some((w) => w.courseId === courseId)) return;
    if (
      course.status !== 'PUBLISHED' ||
      course.ownerId === this.viewerId ||
      this.commerce.hasActiveEnrollment(this.viewerId, courseId)
    ) {
      throw new MockApiError(409, ErrorCode.CourseNotWishlistable);
    }
    if (list.length >= WISHLIST_LIMITS.maxItems)
      throw new MockApiError(422, ErrorCode.WishlistFull);
    list.push({ courseId, addedAt: this.iso() });
  }

  removeFromWishlist(courseId: string): void {
    this.hitRateLimit('wishlistWrite');
    this.requireApp('student');
    const list = this.wishlistOf(this.viewerId);
    const index = list.findIndex((w) => w.courseId === courseId);
    if (index >= 0) list.splice(index, 1);
  }

  wishlistStates(courseIds: readonly string[]): WishlistState[] {
    this.requireApp('student');
    const list = this.wishlistOf(this.viewerId);
    return courseIds.map((courseId) => ({
      courseId,
      wishlisted: list.some((w) => w.courseId === courseId),
    }));
  }

  /* ================================================================ engagement: reports and moderation */

  private subject(type: ReportSubjectType, id: string): MockSubject | null {
    switch (type) {
      case 'REVIEW': {
        const r = this.reviews.find((x) => x.id === id);
        return r
          ? {
              type,
              id,
              courseId: r.courseId,
              authorId: r.userId,
              moderation: r.moderation,
              deleted: r.deletedAt !== null,
              setModeration: (s) => (r.moderation = s),
            }
          : null;
      }
      case 'REVIEW_REPLY': {
        const r = this.reviews.find((x) => x.id === id);
        const reply = r?.reply;
        return r && reply
          ? {
              type,
              id,
              courseId: r.courseId,
              authorId: reply.authorId,
              moderation: reply.moderation,
              deleted: r.deletedAt !== null,
              setModeration: (s) => (reply.moderation = s),
            }
          : null;
      }
      case 'QUESTION': {
        const q = this.questions.find((x) => x.id === id);
        return q
          ? {
              type,
              id,
              courseId: q.courseId,
              authorId: q.authorId,
              moderation: q.moderation,
              deleted: q.deletedAt !== null,
              setModeration: (s) => (q.moderation = s),
            }
          : null;
      }
      case 'ANSWER': {
        const a = this.answers.find((x) => x.id === id);
        return a
          ? {
              type,
              id,
              courseId: a.courseId,
              authorId: a.authorId,
              moderation: a.moderation,
              deleted: a.deletedAt !== null,
              setModeration: (s) => {
                a.moderation = s;
                const q = this.questions.find((x) => x.id === a.questionId);
                if (s === 'HIDDEN' && q?.acceptedAnswerId === a.id) q.acceptedAnswerId = null;
              },
            }
          : null;
      }
    }
  }

  private static readonly NOT_FOUND_CODE: Readonly<Record<ReportSubjectType, string>> = {
    REVIEW: ErrorCode.ReviewNotFound,
    REVIEW_REPLY: ErrorCode.ReplyNotFound,
    QUESTION: ErrorCode.QuestionNotFound,
    ANSWER: ErrorCode.AnswerNotFound,
  };

  /** The reporter must be able to see the subject (public review, or Q&A access). */
  private reportableSubject(type: ReportSubjectType, id: string): MockSubject {
    const s = this.subject(type, id);
    const missing = notFound(LearningMockStore.NOT_FOUND_CODE[type]);
    if (!s || s.deleted) throw missing;
    if (s.moderation !== 'VISIBLE' && s.authorId !== this.viewerId) throw missing;
    if (type === 'REVIEW' || type === 'REVIEW_REPLY') {
      const review = this.reviews.find((r) => r.id === id)!;
      if (!this.isPublic(review)) throw missing;
    } else if (!this.canSeeQa(s.courseId, this.viewerId)) {
      throw missing;
    }
    return s;
  }

  private reportView(r: MockReport): Report {
    return {
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      reason: r.reason,
      comment: r.comment,
      status: r.status,
      createdAt: r.createdAt,
    };
  }

  /** `POST /engagement/{type}/:id/reports`: 201 new, 200 repeat; auto-hide at the threshold. */
  report(
    type: ReportSubjectType,
    subjectId: string,
    input: { reason: ReportReason; comment?: string | undefined },
  ): { status: 200 | 201; report: Report } {
    this.hitRateLimit('report');
    this.requireApp('student', 'instructor');
    const s = this.reportableSubject(type, subjectId);
    if (s.authorId === this.viewerId) throw new MockApiError(422, ErrorCode.CannotReportOwnContent);
    const existing = this.reports.find(
      (r) => r.subjectType === type && r.subjectId === subjectId && r.reporterId === this.viewerId,
    );
    if (existing) return { status: 200, report: this.reportView(existing) };
    const report: MockReport = {
      id: this.nextId(),
      subjectType: type,
      subjectId,
      reporterId: this.viewerId,
      reason: input.reason,
      comment: input.comment ?? null,
      status: 'OPEN',
      createdAt: this.iso(),
      resolvedAt: null,
    };
    this.reports.push(report);
    const open = this.openReports(type, subjectId).length;
    if (open >= this.autoHideReports && s.moderation === 'VISIBLE') {
      this.hide(s, null, null);
      for (const adminId of this.adminIds) {
        this.notify(
          adminId,
          'ADMIN',
          'MODERATION_QUEUE',
          {
            subjectType: type,
            subjectId,
            courseId: s.courseId,
            openReportCount: open,
          },
          null,
        );
      }
    }
    return { status: 201, report: this.reportView(report) };
  }

  private openReports(type: ReportSubjectType, subjectId: string): MockReport[] {
    return this.reports.filter(
      (r) => r.subjectType === type && r.subjectId === subjectId && r.status === 'OPEN',
    );
  }

  private logAction(
    s: MockSubject,
    action: ModerationActionType,
    actorId: string | null,
    reason: string | null,
  ): void {
    this.moderationActions.push({
      id: this.nextId(),
      subjectType: s.type,
      subjectId: s.id,
      action,
      actor: this.actor(actorId),
      reason,
      occurredAt: this.iso(),
    });
  }

  /** Hide + log + redact + notify the author (the moderation notifier). */
  private hide(s: MockSubject, actorId: string | null, reason: string | null): void {
    s.setModeration('HIDDEN');
    this.logAction(s, 'HIDE', actorId, reason);
    this.redact(s.type, s.id);
    const course = this.courseOf(s.courseId);
    this.notify(
      s.authorId,
      s.authorId === course?.ownerId ? 'INSTRUCTOR' : 'STUDENT',
      'CONTENT_HIDDEN',
      {
        subjectType: s.type,
        subjectId: s.id,
        courseId: s.courseId,
        courseTitle: course?.title ?? 'A course',
      },
      null,
    );
  }

  private resolveReports(s: MockSubject, status: 'ACTIONED' | 'DISMISSED'): void {
    for (const r of this.openReports(s.type, s.id)) {
      r.status = status;
      r.resolvedAt = this.iso();
    }
  }

  private moderationSubjectView(s: MockSubject): ModerationSubject {
    return {
      subjectType: s.type,
      subjectId: s.id,
      courseId: s.courseId,
      courseTitle: this.courseOf(s.courseId)?.title ?? null,
      moderationStatus: s.moderation,
      openReportCount: this.openReports(s.type, s.id).length,
      actions: this.moderationActions.filter(
        (a) => a.subjectType === s.type && a.subjectId === s.id,
      ),
    };
  }

  /**
   * Admin actions. `hide`: VISIBLE → HIDDEN, or confirms an auto-hide (its OPEN reports become
   * ACTIONED); `restore`: HIDDEN → VISIBLE and dismisses the open reports; `dismiss-reports`:
   * needs open reports. Anything else is 409 `invalid_state_transition`.
   */
  moderate(
    type: ReportSubjectType,
    subjectId: string,
    action: 'hide' | 'restore' | 'dismiss-reports',
    reason: string,
  ): ModerationSubject {
    this.requireApp('admin');
    const s = this.subject(type, subjectId);
    if (!s) throw notFound(LearningMockStore.NOT_FOUND_CODE[type]);
    const open = this.openReports(type, subjectId).length;
    const conflict = new MockApiError(409, ErrorCode.InvalidStateTransition);
    if (action === 'hide') {
      if (s.moderation === 'HIDDEN' && open === 0) throw conflict;
      if (s.moderation === 'VISIBLE') this.hide(s, this.viewerId, reason);
      else this.logAction(s, 'HIDE', this.viewerId, reason);
      this.resolveReports(s, 'ACTIONED');
    } else if (action === 'restore') {
      if (s.moderation !== 'HIDDEN') throw conflict;
      s.setModeration('VISIBLE');
      this.logAction(s, 'RESTORE', this.viewerId, reason);
      this.resolveReports(s, 'DISMISSED');
    } else {
      if (open === 0) throw conflict;
      this.logAction(s, 'DISMISS_REPORTS', this.viewerId, reason);
      this.resolveReports(s, 'DISMISSED');
    }
    return this.moderationSubjectView({
      ...s,
      moderation: this.subject(type, subjectId)!.moderation,
    });
  }

  moderationQueue(query: {
    type?: ReportSubjectType | undefined;
    status: ReportStatus;
  }): ModerationQueueItem[] {
    this.requireApp('admin');
    const keys = new Map<string, MockReport[]>();
    for (const r of this.reports) {
      if (query.type !== undefined && r.subjectType !== query.type) continue;
      const k = `${r.subjectType}:${r.subjectId}`;
      keys.set(k, [...(keys.get(k) ?? []), r]);
    }
    const items: ModerationQueueItem[] = [];
    for (const reports of keys.values()) {
      if (!reports.some((r) => r.status === query.status)) continue;
      const first = reports[0]!;
      const s = this.subject(first.subjectType, first.subjectId);
      if (!s) continue;
      const newest = [...reports].sort(newestFirst);
      items.push({
        ...this.moderationSubjectView(s),
        preview: this.preview(s),
        reports: newest.slice(0, 20).map((r) => ({
          ...this.reportView(r),
          reporter: this.actor(r.reporterId),
          resolvedAt: r.resolvedAt,
        })),
        lastReportedAt: newest[0]!.createdAt,
      });
    }
    return items.sort((a, b) =>
      a.lastReportedAt === b.lastReportedAt
        ? a.subjectId < b.subjectId
          ? 1
          : -1
        : a.lastReportedAt < b.lastReportedAt
          ? 1
          : -1,
    );
  }

  private preview(s: MockSubject): ModerationQueueItem['preview'] {
    const author = this.actor(s.authorId);
    switch (s.type) {
      case 'REVIEW': {
        const r = this.reviews.find((x) => x.id === s.id)!;
        return {
          title: null,
          body: r.body,
          bodyIsMarkdown: false,
          rating: r.rating,
          author,
          createdAt: r.createdAt,
          deleted: s.deleted,
        };
      }
      case 'REVIEW_REPLY': {
        const reply = this.reviews.find((x) => x.id === s.id)!.reply!;
        return {
          title: null,
          body: reply.body,
          bodyIsMarkdown: false,
          rating: null,
          author,
          createdAt: reply.createdAt,
          deleted: s.deleted,
        };
      }
      case 'QUESTION': {
        const q = this.questions.find((x) => x.id === s.id)!;
        return {
          title: q.title,
          body: q.bodyMd,
          bodyIsMarkdown: true,
          rating: null,
          author,
          createdAt: q.createdAt,
          deleted: s.deleted,
        };
      }
      case 'ANSWER': {
        const a = this.answers.find((x) => x.id === s.id)!;
        return {
          title: null,
          body: a.bodyMd,
          bodyIsMarkdown: true,
          rating: null,
          author,
          createdAt: a.createdAt,
          deleted: s.deleted,
        };
      }
    }
  }

  /** Test helper: a report by another user (to reach the auto-hide threshold). */
  seedReport(
    type: ReportSubjectType,
    subjectId: string,
    reporterId: string,
    reason: ReportReason = 'SPAM',
  ): void {
    const viewer = this.commerce.viewerId;
    const app = this.viewerApp;
    this.commerce.viewerId = reporterId;
    this.viewerApp = 'student';
    try {
      this.report(type, subjectId, { reason });
    } finally {
      this.commerce.viewerId = viewer;
      this.viewerApp = app;
    }
  }

  /* ================================================================ notifications */

  private prefKey(
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
  ): string {
    return `${userId}:${category}:${channel}`;
  }

  private preferenceEnabled(
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
  ): boolean {
    if (isPreferenceLocked(category, channel)) return true;
    return (
      this.preferences.get(this.prefKey(userId, category, channel)) ??
      NOTIFICATION_CATEGORY_META[category].defaults[channel]
    );
  }

  /** A notifier: insert (if IN_APP is on), then push `notification.created` + `.unread`. */
  notify<K extends NotificationKind>(
    userId: string,
    app: NotificationApp,
    kind: K,
    payload: NotificationPayloadOf<K>,
    subject: { type: NotificationSubjectType; id: string } | null,
  ): void {
    const meta = NOTIFICATION_KIND_META[kind];
    if (!this.preferenceEnabled(userId, meta.category, 'IN_APP')) return;
    const content = NotificationContentSchema.parse({ kind, payload });
    const n: MockNotification = {
      id: this.nextId(),
      userId,
      app,
      content,
      subjectType: subject?.type ?? meta.subjectType,
      subjectId: subject?.id ?? null,
      createdAt: this.iso(),
      readAt: null,
    };
    this.notifications.push(n);
    const room = realtimeUserRoom(userId, app);
    this.emit(room, 'notification.created', { id: n.id, kind, app });
    this.emit(room, 'notification.unread', { count: this.unreadCountOf(userId, app).count });
  }

  /** The moderation notifier: redact every row about the subject. */
  private redact(type: NotificationSubjectType, id: string): void {
    for (const n of this.notifications) {
      const about =
        (n.subjectType === type && n.subjectId === id) ||
        (type === 'QUESTION' &&
          'questionId' in n.content.payload &&
          n.content.payload.questionId === id) ||
        (type === 'REVIEW' &&
          n.content.kind === 'REVIEW_REPLY' &&
          n.content.payload.reviewId === id);
      if (about) n.content = redactNotificationPayload(n.content);
    }
  }

  private notificationView(n: MockNotification): Notification {
    return {
      id: n.id,
      app: n.app,
      category: NOTIFICATION_KIND_META[n.content.kind].category,
      subjectType: n.subjectType,
      subjectId: n.subjectId,
      createdAt: n.createdAt,
      readAt: n.readAt,
      ...n.content,
    } as Notification;
  }

  private inbox(userId = this.viewerId, app = this.viewerAudience): MockNotification[] {
    return this.notifications.filter((n) => n.userId === userId && n.app === app).sort(newestFirst);
  }

  listNotifications(unreadOnly: boolean): Notification[] {
    return this.inbox()
      .filter((n) => !unreadOnly || n.readAt === null)
      .map((n) => this.notificationView(n));
  }

  private unreadCountOf(userId: string, app: NotificationApp): UnreadCount {
    const count = Math.min(
      UNREAD_COUNT_CAP,
      this.notifications.filter((n) => n.userId === userId && n.app === app && n.readAt === null)
        .length,
    );
    return { count, capped: count >= UNREAD_COUNT_CAP };
  }

  unreadCount(): UnreadCount {
    return this.unreadCountOf(this.viewerId, this.viewerAudience);
  }

  private pushUnread(): void {
    this.emit(realtimeUserRoom(this.viewerId, this.viewerAudience), 'notification.unread', {
      count: this.unreadCount().count,
    });
  }

  markRead(notificationId: string): void {
    const n = this.inbox().find((x) => x.id === notificationId);
    if (!n) throw notFound(ErrorCode.NotificationNotFound);
    n.readAt ??= this.iso();
    this.pushUnread();
  }

  /** Marks every row of the inbox at or before `upToId` (keyset order) read. */
  markAllRead(upToId: string): void {
    const inbox = this.inbox();
    const index = inbox.findIndex((x) => x.id === upToId);
    if (index < 0) throw notFound(ErrorCode.NotificationNotFound);
    const at = this.iso();
    for (const n of inbox.slice(index)) n.readAt ??= at;
    this.pushUnread();
  }

  preferencesOf(userId = this.viewerId): NotificationPreference[] {
    return NOTIFICATION_CATEGORIES.flatMap((category) =>
      NOTIFICATION_CHANNELS.map((channel) => {
        const stored = this.preferences.get(this.prefKey(userId, category, channel));
        const locked = isPreferenceLocked(category, channel);
        return {
          category,
          channel,
          enabled: this.preferenceEnabled(userId, category, channel),
          locked,
          isDefault: locked || stored === undefined,
        };
      }),
    );
  }

  updatePreferences(
    items: readonly {
      category: NotificationCategory;
      channel: NotificationChannel;
      enabled: boolean;
    }[],
  ): NotificationPreference[] {
    if (items.some((i) => isPreferenceLocked(i.category, i.channel))) {
      throw new MockApiError(422, ErrorCode.PreferenceLocked);
    }
    for (const i of items) {
      this.preferences.set(this.prefKey(this.viewerId, i.category, i.channel), i.enabled);
    }
    return this.preferencesOf();
  }

  /** The token a notification e-mail would carry (`v1.{userId}.{category}.{mac}`). */
  unsubscribeToken(userId: string, category: NotificationCategory): string {
    return `v1.${userId}.${category}.${fixtureFingerprint(`v1|${userId}|${category}`).slice(0, 32)}`;
  }

  unsubscribe(token: string): void {
    this.hitRateLimit('unsubscribe', 'ip');
    const invalid = new MockApiError(400, ErrorCode.InvalidUnsubscribeToken);
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw invalid;
    const [, userId, category] = parts as [string, string, string, string];
    if (
      !(NOTIFICATION_CATEGORIES as readonly string[]).includes(category) ||
      token !== this.unsubscribeToken(userId, category as NotificationCategory) ||
      isPreferenceLocked(category as NotificationCategory, 'EMAIL')
    ) {
      throw invalid;
    }
    this.preferences.set(this.prefKey(userId, category as NotificationCategory, 'EMAIL'), false);
  }

  /** `POST /realtime/tickets`: single use, 30 s. */
  issueRealtimeTicket(): RealtimeTicket {
    this.hitRateLimit('realtimeTicket');
    if (!this.realtimeAvailable) throw new MockApiError(503, ErrorCode.RealtimeUnavailable);
    this.seq += 1;
    let ticket = '';
    for (let i = 0; i < 43; i++) ticket += BASE64URL[(this.seq * 31 + i * 17) % 64];
    return {
      ticket,
      url: this.realtimeUrl,
      expiresAt: this.iso(REALTIME_LIMITS.ticketTtlSeconds * 1000),
    };
  }

  /* ================================================================ quiz authoring */

  private quizLecture(courseId: string, lectureId: string): MockLecture {
    this.ownedCourse(courseId);
    const curriculum = this.curricula.get(courseId);
    const lecture = curriculum && this.liveLectures(curriculum).find((l) => l.id === lectureId);
    if (!lecture) throw notFound(ErrorCode.LectureNotFound);
    if (lecture.type !== 'QUIZ') throw new MockApiError(422, ErrorCode.LectureTypeMismatch);
    return lecture;
  }

  private workingQuiz(lecture: MockLecture): MockWorkingQuiz {
    let quiz = this.workingQuizzes.get(lecture.id);
    if (!quiz) {
      const at = this.iso();
      const source: MockQuiz = lecture.quiz ?? {
        passPct: QUIZ_LIMITS.defaultPassPct,
        questions: [],
      };
      quiz = {
        passPct: source.passPct,
        questions: structuredClone(source.questions).map((q) => ({ ...q, updatedAt: at })),
        updatedAt: at,
      };
      this.workingQuizzes.set(lecture.id, quiz);
    }
    return quiz;
  }

  private writableQuiz(
    courseId: string,
    lectureId: string,
  ): { lecture: MockLecture; quiz: MockWorkingQuiz } {
    const lecture = this.quizLecture(courseId, lectureId);
    if (this.courseOf(courseId)!.status === 'IN_REVIEW') {
      throw new MockApiError(409, ErrorCode.CourseInReview);
    }
    const quiz = this.workingQuiz(lecture);
    this.courseVersions.set(courseId, (this.courseVersions.get(courseId) ?? 1) + 1);
    quiz.updatedAt = this.iso();
    return { lecture, quiz };
  }

  private questionAuthoringView(q: MockWorkingQuestion, position: number): QuizQuestionAuthoring {
    return {
      id: q.id,
      position,
      kind: q.kind,
      promptMd: q.promptMd,
      explanationMd: q.explanationMd,
      options: q.options.map((o, i) => ({ position: i, text: o.text, isCorrect: o.isCorrect })),
      complete: isQuizQuestionComplete(q.kind, q.options),
      updatedAt: q.updatedAt,
    };
  }

  private quizAuthoringView(
    courseId: string,
    lectureId: string,
    quiz: MockWorkingQuiz,
  ): QuizAuthoring {
    return {
      courseId,
      lectureId,
      version: this.courseVersions.get(courseId) ?? 1,
      locked: this.courseOf(courseId)?.status === 'IN_REVIEW',
      passPct: quiz.passPct,
      questions: quiz.questions.map((q, i) => this.questionAuthoringView(q, i)),
      updatedAt: quiz.updatedAt,
    };
  }

  quizAuthoring(courseId: string, lectureId: string): QuizAuthoring {
    const lecture = this.quizLecture(courseId, lectureId);
    return this.quizAuthoringView(courseId, lectureId, this.workingQuiz(lecture));
  }

  updateQuizSettings(courseId: string, lectureId: string, passPct: number): QuizAuthoring {
    const { quiz } = this.writableQuiz(courseId, lectureId);
    quiz.passPct = passPct;
    return this.quizAuthoringView(courseId, lectureId, quiz);
  }

  addQuizQuestion(
    courseId: string,
    lectureId: string,
    input: { kind: QuizQuestionKind; promptMd: string; explanationMd?: string | undefined },
  ): QuizQuestionAuthoring {
    const { quiz } = this.writableQuiz(courseId, lectureId);
    if (quiz.questions.length >= QUIZ_LIMITS.maxQuestions) {
      throw new MockApiError(422, ErrorCode.QuizLimitExceeded);
    }
    const q: MockWorkingQuestion = {
      id: this.nextId(),
      kind: input.kind,
      promptMd: input.promptMd,
      explanationMd: input.explanationMd ?? null,
      options: [],
      updatedAt: this.iso(),
    };
    quiz.questions.push(q);
    return this.questionAuthoringView(q, quiz.questions.length - 1);
  }

  private workingQuestion(quiz: MockWorkingQuiz, questionId: string): MockWorkingQuestion {
    const q = quiz.questions.find((x) => x.id === questionId);
    if (!q) throw notFound(ErrorCode.QuizQuestionNotFound);
    return q;
  }

  updateQuizQuestion(
    courseId: string,
    lectureId: string,
    questionId: string,
    input: {
      kind?: QuizQuestionKind | undefined;
      promptMd?: string | undefined;
      explanationMd?: string | null | undefined;
    },
  ): QuizQuestionAuthoring {
    const { quiz } = this.writableQuiz(courseId, lectureId);
    const q = this.workingQuestion(quiz, questionId);
    if (input.kind !== undefined) q.kind = input.kind;
    if (input.promptMd !== undefined) q.promptMd = input.promptMd;
    if (input.explanationMd !== undefined) q.explanationMd = input.explanationMd;
    q.updatedAt = this.iso();
    return this.questionAuthoringView(q, quiz.questions.indexOf(q));
  }

  deleteQuizQuestion(courseId: string, lectureId: string, questionId: string): void {
    const { quiz } = this.writableQuiz(courseId, lectureId);
    const q = this.workingQuestion(quiz, questionId);
    quiz.questions.splice(quiz.questions.indexOf(q), 1);
  }

  putQuizQuestionOptions(
    courseId: string,
    lectureId: string,
    questionId: string,
    options: readonly { text: string; isCorrect: boolean }[],
  ): QuizQuestionAuthoring {
    const { quiz } = this.writableQuiz(courseId, lectureId);
    const q = this.workingQuestion(quiz, questionId);
    q.options = options.map((o) => ({ text: o.text, isCorrect: o.isCorrect }));
    q.updatedAt = this.iso();
    return this.questionAuthoringView(q, quiz.questions.indexOf(q));
  }

  reorderQuizQuestions(
    courseId: string,
    lectureId: string,
    questionIds: readonly string[],
  ): QuizAuthoring {
    const { quiz } = this.writableQuiz(courseId, lectureId);
    const current = quiz.questions.map((q) => q.id);
    if (questionIds.length !== current.length || !questionIds.every((id) => current.includes(id))) {
      throw new MockApiError(409, ErrorCode.OrderMismatch);
    }
    quiz.questions = questionIds.map((id) => quiz.questions.find((q) => q.id === id)!);
    return this.quizAuthoringView(courseId, lectureId, quiz);
  }

  /** Test helper: an approval made the working quiz live (a new live revision). */
  publishWorkingQuiz(courseId: string, lectureId: string): string {
    const curriculum = this.curricula.get(courseId);
    const lecture = curriculum && this.liveLectures(curriculum).find((l) => l.id === lectureId);
    const quiz = this.workingQuizzes.get(lectureId);
    if (!curriculum || !lecture || !quiz) throw notFound(ErrorCode.LectureNotFound);
    lecture.quiz = {
      passPct: quiz.passPct,
      questions: quiz.questions.map((q) => ({
        id: q.id,
        kind: q.kind,
        promptMd: q.promptMd,
        explanationMd: q.explanationMd,
        options: q.options.map((o) => ({ ...o })),
      })),
    };
    curriculum.liveRevisionId = this.nextId();
    return curriculum.liveRevisionId;
  }

  /** `GET /admin/course-revisions/:revisionId/lectures/:lectureId/quiz` (live revisions only). */
  revisionQuiz(revisionId: string, lectureId: string): RevisionQuiz {
    this.requireApp('admin');
    const curriculum = [...this.curricula.values()].find((c) => c.liveRevisionId === revisionId);
    if (!curriculum) throw notFound(ErrorCode.NotFound);
    const lecture = this.liveLectures(curriculum).find((l) => l.id === lectureId);
    if (!lecture) throw notFound(ErrorCode.LectureNotFound);
    if (lecture.type !== 'QUIZ' || !lecture.quiz)
      throw new MockApiError(422, ErrorCode.LectureTypeMismatch);
    return {
      revisionId,
      lectureId,
      passPct: lecture.quiz.passPct,
      questions: lecture.quiz.questions.map((q, position) => ({
        id: q.id,
        position,
        kind: q.kind,
        promptMd: q.promptMd,
        explanationMd: q.explanationMd,
        options: q.options.map((o, i) => ({ position: i, text: o.text, isCorrect: o.isCorrect })),
      })),
    };
  }
}

export function createLearningMockStore(seed: LearningMockSeed = {}): LearningMockStore {
  return new LearningMockStore(seed);
}
