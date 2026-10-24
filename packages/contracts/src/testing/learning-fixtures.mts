import type { LectureType } from '../http/catalog.js';
import {
  type Announcement,
  AnnouncementSchema,
  type WishlistItem,
  WishlistItemSchema,
} from '../http/engagement-community.js';
import {
  type ModerationQueueItem,
  ModerationQueueItemSchema,
  type Report,
  ReportSchema,
} from '../http/engagement-moderation.js';
import {
  type Answer,
  AnswerSchema,
  type Question,
  type QuestionDetail,
  QuestionDetailSchema,
  QuestionSchema,
} from '../http/engagement-qa.js';
import {
  type CourseRating,
  CourseRatingSchema,
  type InstructorReview,
  InstructorReviewSchema,
  type MyCourseReview,
  MyCourseReviewSchema,
  type PublicReview,
  PublicReviewSchema,
  type RatingHistogram,
  ratingAverage,
} from '../http/engagement-reviews.js';
import {
  type Certificate,
  type CertificateVerification,
  CertificateSchema,
  CertificateVerificationSchema,
  type CompletionState,
  CompletionStateSchema,
  type Note,
  NoteSchema,
  type PlayerBootstrap,
  PlayerBootstrapSchema,
  type ProgressAck,
  ProgressAckSchema,
  type QuizAttempt,
  type QuizAttemptDetail,
  QuizAttemptDetailSchema,
  QuizAttemptSchema,
  type QuizResult,
  QuizResultSchema,
} from '../http/learning.js';
import {
  type Notification,
  type NotificationPreferences,
  NotificationPreferencesSchema,
  NotificationSchema,
  type UnreadCount,
  UnreadCountSchema,
  UNREAD_COUNT_CAP,
} from '../http/notifications.js';
import {
  type QuizAuthoring,
  QuizAuthoringSchema,
  type QuizQuestionKind,
  type RevisionQuiz,
  RevisionQuizSchema,
} from '../http/quiz.js';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KIND_META,
} from '../notifications/notification-kinds.js';
import { type RealtimeTicket, RealtimeTicketSchema } from '../realtime.js';
import { FIXTURE_IDS, FIXTURE_NOW, fixtureId } from './fixtures.mjs';

/**
 * Fixture builders for the Phase 5 learning, engagement and notification contracts, in the
 * style of `fixtures.mts`: deterministic ids and `FIXTURE_NOW`, and every builder returns a value
 * **parsed by its contracts schema** (an invalid override throws in the test that made it).
 */

/** Well-known Phase 5 ids (the default curricula and the builders use them). */
export const LEARNING_FIXTURE_IDS = Object.freeze({
  revision: fixtureId(0x5e01),
  revision2: fixtureId(0x5e02),
  revisionFree: fixtureId(0x5e03),
  section1: fixtureId(0x5c01),
  section2: fixtureId(0x5c02),
  section3: fixtureId(0x5c03),
  sectionFree: fixtureId(0x5c04),
  lectureVideo: fixtureId(0x1e01),
  lectureArticle: fixtureId(0x1e02),
  lectureResource: fixtureId(0x1e03),
  lectureQuiz: fixtureId(0x1e04),
  course2Video: fixtureId(0x1e21),
  course2Article: fixtureId(0x1e22),
  freeVideo: fixtureId(0x1e31),
  freeArticle: fixtureId(0x1e32),
  quizQuestion1: fixtureId(0x9a01),
  quizQuestion2: fixtureId(0x9a02),
  quizQuestion3: fixtureId(0x9a03),
  note: fixtureId(0x7e01),
  attempt: fixtureId(0xa771),
  certificate: fixtureId(0xce71),
  review: fixtureId(0x4e71),
  question: fixtureId(0x9e51),
  answer: fixtureId(0xa45e),
  announcement: fixtureId(0xa110),
  report: fixtureId(0x4e90),
  notification: fixtureId(0x0f01),
});

/** A valid certificate code (26 Crockford base32 characters). */
export const FIXTURE_CERTIFICATE_CODE = '01J9ZP4X6V8Q2M3N5R7T9W0Y1A';

/* ----------------------------------------------------------------------------------------
 * Mock curricula (the live revision of a course, as `CatalogFacade.getLiveCurriculum` sees it)
 * -------------------------------------------------------------------------------------- */

export interface MockQuizQuestion {
  id: string;
  kind: QuizQuestionKind;
  promptMd: string;
  explanationMd: string | null;
  /** Positions follow the array order. The key never leaves the store on a student route. */
  options: { text: string; isCorrect: boolean }[];
}

export interface MockQuiz {
  passPct: number;
  questions: MockQuizQuestion[];
}

export interface MockLecture {
  id: string;
  type: LectureType;
  title: string;
  /** VIDEO only. */
  durationSeconds: number | null;
  isPreview?: boolean;
  /** QUIZ only. */
  quiz?: MockQuiz;
}

export interface MockSection {
  id: string;
  title: string;
  lectures: MockLecture[];
}

export interface MockCurriculum {
  courseId: string;
  liveRevisionId: string;
  sections: MockSection[];
}

/** A three-question quiz: single choice, multiple choice and true/false (pass 70%). */
export function defaultMockQuiz(): MockQuiz {
  const ids = LEARNING_FIXTURE_IDS;
  return {
    passPct: 70,
    questions: [
      {
        id: ids.quizQuestion1,
        kind: 'SINGLE_CHOICE',
        promptMd: 'Which keyword declares a **constant**?',
        explanationMd: '`const` bindings cannot be reassigned.',
        options: [
          { text: 'let', isCorrect: false },
          { text: 'const', isCorrect: true },
          { text: 'var', isCorrect: false },
        ],
      },
      {
        id: ids.quizQuestion2,
        kind: 'MULTIPLE_CHOICE',
        promptMd: 'Which of these are primitive types?',
        explanationMd: null,
        options: [
          { text: 'string', isCorrect: true },
          { text: 'object', isCorrect: false },
          { text: 'boolean', isCorrect: true },
          { text: 'Array', isCorrect: false },
        ],
      },
      {
        id: ids.quizQuestion3,
        kind: 'SINGLE_CHOICE',
        promptMd: 'TypeScript types exist at runtime.',
        explanationMd: 'Types are erased when compiling to JavaScript.',
        options: [
          { text: 'True', isCorrect: false },
          { text: 'False', isCorrect: true },
        ],
      },
    ],
  };
}

/**
 * Curricula of the default mock courses: "Complete TypeScript" has a VIDEO (5 min), an ARTICLE,
 * a RESOURCE and a QUIZ; the other two have a short video and an article.
 */
export function defaultMockCurricula(): MockCurriculum[] {
  const ids = LEARNING_FIXTURE_IDS;
  return [
    {
      courseId: FIXTURE_IDS.course,
      liveRevisionId: ids.revision,
      sections: [
        {
          id: ids.section1,
          title: 'Getting started',
          lectures: [
            {
              id: ids.lectureVideo,
              type: 'VIDEO',
              title: 'Welcome',
              durationSeconds: 300,
              isPreview: true,
            },
            {
              id: ids.lectureArticle,
              type: 'ARTICLE',
              title: 'Setup notes',
              durationSeconds: null,
            },
          ],
        },
        {
          id: ids.section2,
          title: 'Practice',
          lectures: [
            {
              id: ids.lectureResource,
              type: 'RESOURCE',
              title: 'Cheat sheet',
              durationSeconds: null,
            },
            {
              id: ids.lectureQuiz,
              type: 'QUIZ',
              title: 'Check yourself',
              durationSeconds: null,
              quiz: defaultMockQuiz(),
            },
          ],
        },
      ],
    },
    {
      courseId: FIXTURE_IDS.course2,
      liveRevisionId: ids.revision2,
      sections: [
        {
          id: ids.section3,
          title: 'Basics',
          lectures: [
            { id: ids.course2Video, type: 'VIDEO', title: 'Tables', durationSeconds: 120 },
            { id: ids.course2Article, type: 'ARTICLE', title: 'Indexes', durationSeconds: null },
          ],
        },
      ],
    },
    {
      courseId: FIXTURE_IDS.freeCourse,
      liveRevisionId: ids.revisionFree,
      sections: [
        {
          id: ids.sectionFree,
          title: 'Git',
          lectures: [
            { id: ids.freeVideo, type: 'VIDEO', title: 'Commits', durationSeconds: 60 },
            { id: ids.freeArticle, type: 'ARTICLE', title: 'Branches', durationSeconds: null },
          ],
        },
      ],
    },
  ];
}

/* ----------------------------------------------------------------------------------------
 * Learning
 * -------------------------------------------------------------------------------------- */

export function makePlayerBootstrap(overrides: Partial<PlayerBootstrap> = {}): PlayerBootstrap {
  const ids = LEARNING_FIXTURE_IDS;
  const lecture = (id: string, type: LectureType, title: string, extra = {}) => ({
    id,
    type,
    title,
    durationSeconds: null,
    isPreview: false,
    quiz: null,
    completed: false,
    completedAt: null,
    positionSeconds: null,
    coveragePct: null,
    ...extra,
  });
  return PlayerBootstrapSchema.parse({
    courseId: FIXTURE_IDS.course,
    slug: 'complete-typescript',
    title: 'Complete TypeScript',
    status: 'PUBLISHED',
    liveRevisionId: ids.revision,
    mode: 'LEARNER',
    instructor: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    sections: [
      {
        id: ids.section1,
        title: 'Getting started',
        lectures: [
          lecture(ids.lectureVideo, 'VIDEO', 'Welcome', {
            durationSeconds: 300,
            isPreview: true,
            positionSeconds: 42,
            coveragePct: 15,
          }),
          lecture(ids.lectureArticle, 'ARTICLE', 'Setup notes', {
            completed: true,
            completedAt: FIXTURE_NOW,
          }),
        ],
      },
      {
        id: ids.section2,
        title: 'Practice',
        lectures: [
          lecture(ids.lectureResource, 'RESOURCE', 'Cheat sheet'),
          lecture(ids.lectureQuiz, 'QUIZ', 'Check yourself', {
            quiz: { passPct: 70, questionCount: 3 },
          }),
        ],
      },
    ],
    progress: { completed: 1, total: 4, pct: 25 },
    resume: { lectureId: ids.lectureVideo, positionSeconds: 42 },
    completedAt: null,
    newContent: false,
    certificate: null,
    ...overrides,
  });
}

export function makeProgressAck(overrides: Partial<ProgressAck> = {}): ProgressAck {
  return ProgressAckSchema.parse({
    lectureCompleted: false,
    courseCompleted: false,
    coursePct: 25,
    ...overrides,
  });
}

export function makeCompletionState(overrides: Partial<CompletionState> = {}): CompletionState {
  const completed = overrides.completed ?? true;
  return CompletionStateSchema.parse({
    lectureId: LEARNING_FIXTURE_IDS.lectureArticle,
    completed,
    cause: completed ? 'ARTICLE_READ' : null,
    completedAt: completed ? FIXTURE_NOW : null,
    progress: { completed: completed ? 1 : 0, total: 4, pct: completed ? 25 : 0 },
    courseCompletedAt: null,
    ...overrides,
  });
}

export function makeNote(overrides: Partial<Note> = {}): Note {
  return NoteSchema.parse({
    id: LEARNING_FIXTURE_IDS.note,
    courseId: FIXTURE_IDS.course,
    lectureId: LEARNING_FIXTURE_IDS.lectureVideo,
    positionSeconds: 42,
    bodyMd: 'Remember: `const` is block scoped.',
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

/** The default quiz as a learner sees it (no keys). */
function attemptQuestions() {
  return defaultMockQuiz().questions.map((q, position) => ({
    id: q.id,
    position,
    kind: q.kind,
    promptMd: q.promptMd,
    options: q.options.map((o, i) => ({ position: i, text: o.text })),
  }));
}

export function makeQuizAttempt(overrides: Partial<QuizAttempt> = {}): QuizAttempt {
  return QuizAttemptSchema.parse({
    id: LEARNING_FIXTURE_IDS.attempt,
    courseId: FIXTURE_IDS.course,
    lectureId: LEARNING_FIXTURE_IDS.lectureQuiz,
    revisionId: LEARNING_FIXTURE_IDS.revision,
    status: 'IN_PROGRESS',
    passPct: 70,
    questionCount: 3,
    startedAt: FIXTURE_NOW,
    submittedAt: null,
    abandonedAt: null,
    questions: attemptQuestions(),
    ...overrides,
  });
}

/** Default: a passed attempt (2 of 3 = 67%, pass 60%) with keys revealed. */
export function makeQuizResult(overrides: Partial<QuizResult> = {}): QuizResult {
  const passed = overrides.passed ?? true;
  const revealed = overrides.revealed ?? passed;
  const quiz = defaultMockQuiz();
  const selections = [[1], [0, 2], [0]];
  const questions = quiz.questions.map((q, position) => {
    const correct = q.options.flatMap((o, i) => (o.isCorrect ? [i] : []));
    const selected = selections[position] ?? [];
    return {
      questionId: q.id,
      position,
      selectedOptions: selected,
      yourAnswerCorrect:
        selected.length === correct.length && selected.every((p) => correct.includes(p)),
      correctOptions: revealed ? correct : null,
      explanationMd: revealed ? q.explanationMd : null,
    };
  });
  const correctCount = questions.filter((q) => q.yourAnswerCorrect).length;
  const scorePct = Math.round((correctCount / questions.length) * 100);
  return QuizResultSchema.parse({
    attemptId: LEARNING_FIXTURE_IDS.attempt,
    courseId: FIXTURE_IDS.course,
    lectureId: LEARNING_FIXTURE_IDS.lectureQuiz,
    scorePct,
    correctCount,
    questionCount: questions.length,
    passPct: passed ? 60 : 70,
    passed,
    revealed,
    submittedAt: FIXTURE_NOW,
    questions,
    ...overrides,
  });
}

export function makeQuizAttemptDetail(
  overrides: Partial<QuizAttemptDetail> = {},
): QuizAttemptDetail {
  const status = overrides.status ?? 'SUBMITTED';
  const result = status === 'SUBMITTED' ? makeQuizResult() : null;
  return QuizAttemptDetailSchema.parse({
    ...makeQuizAttempt({ status }),
    passPct: result?.passPct ?? 70,
    submittedAt: status === 'SUBMITTED' ? FIXTURE_NOW : null,
    abandonedAt: status === 'ABANDONED' ? FIXTURE_NOW : null,
    result,
    ...overrides,
  });
}

export function makeCertificate(overrides: Partial<Certificate> = {}): Certificate {
  const status = overrides.status ?? 'ACTIVE';
  return CertificateSchema.parse({
    id: LEARNING_FIXTURE_IDS.certificate,
    code: FIXTURE_CERTIFICATE_CODE,
    courseId: FIXTURE_IDS.course,
    courseSlug: 'complete-typescript',
    courseTitle: 'Complete TypeScript',
    recipientName: 'Jane Student',
    instructorName: 'Ada Instructor',
    status,
    issuedAt: FIXTURE_NOW,
    revokedAt: status === 'REVOKED' ? FIXTURE_NOW : null,
    pdfReady: true,
    ...overrides,
  });
}

export function makeCertificateVerification(
  overrides: Partial<CertificateVerification> = {},
): CertificateVerification {
  const status = overrides.status ?? 'ACTIVE';
  return CertificateVerificationSchema.parse({
    code: FIXTURE_CERTIFICATE_CODE,
    status,
    recipientName: 'Jane Student',
    courseTitle: 'Complete TypeScript',
    instructorName: 'Ada Instructor',
    issuedAt: FIXTURE_NOW,
    revokedAt: status === 'REVOKED' ? FIXTURE_NOW : null,
    courseSlug: 'complete-typescript',
    pdfAvailable: status === 'ACTIVE',
    ...overrides,
  });
}

/* ----------------------------------------------------------------------------------------
 * Quiz authoring
 * -------------------------------------------------------------------------------------- */

export function makeQuizAuthoring(overrides: Partial<QuizAuthoring> = {}): QuizAuthoring {
  const quiz = defaultMockQuiz();
  return QuizAuthoringSchema.parse({
    courseId: FIXTURE_IDS.course,
    lectureId: LEARNING_FIXTURE_IDS.lectureQuiz,
    version: 3,
    locked: false,
    passPct: quiz.passPct,
    questions: quiz.questions.map((q, position) => ({
      id: q.id,
      position,
      kind: q.kind,
      promptMd: q.promptMd,
      explanationMd: q.explanationMd,
      options: q.options.map((o, i) => ({ position: i, ...o })),
      complete: true,
      updatedAt: FIXTURE_NOW,
    })),
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeRevisionQuiz(overrides: Partial<RevisionQuiz> = {}): RevisionQuiz {
  const quiz = defaultMockQuiz();
  return RevisionQuizSchema.parse({
    revisionId: LEARNING_FIXTURE_IDS.revision,
    lectureId: LEARNING_FIXTURE_IDS.lectureQuiz,
    passPct: quiz.passPct,
    questions: quiz.questions.map((q, position) => ({
      id: q.id,
      position,
      kind: q.kind,
      promptMd: q.promptMd,
      explanationMd: q.explanationMd,
      options: q.options.map((o, i) => ({ position: i, ...o })),
    })),
    ...overrides,
  });
}

/* ----------------------------------------------------------------------------------------
 * Engagement
 * -------------------------------------------------------------------------------------- */

/** `histogram` drives `count` and `average` unless overridden. */
export function makeCourseRating(
  overrides: Partial<CourseRating> & { histogram?: RatingHistogram } = {},
): CourseRating {
  const histogram = overrides.histogram ?? { '1': 0, '2': 1, '3': 2, '4': 10, '5': 27 };
  const count = Object.values(histogram).reduce((sum, n) => sum + n, 0);
  return CourseRatingSchema.parse({
    courseId: FIXTURE_IDS.course,
    average: ratingAverage(histogram),
    count,
    histogram,
    ...overrides,
  });
}

export function makePublicReview(overrides: Partial<PublicReview> = {}): PublicReview {
  return PublicReviewSchema.parse({
    id: LEARNING_FIXTURE_IDS.review,
    rating: 5,
    body: 'Clear explanations and great exercises.',
    author: { id: FIXTURE_IDS.student, displayName: 'Jane Student' },
    createdAt: FIXTURE_NOW,
    editedAt: null,
    reply: null,
    ...overrides,
  });
}

export function makeMyCourseReview(overrides: Partial<MyCourseReview> = {}): MyCourseReview {
  return MyCourseReviewSchema.parse({
    courseId: FIXTURE_IDS.course,
    review: {
      id: LEARNING_FIXTURE_IDS.review,
      courseId: FIXTURE_IDS.course,
      rating: 5,
      body: 'Clear explanations and great exercises.',
      state: 'PUBLISHED',
      createdAt: FIXTURE_NOW,
      editedAt: null,
      reply: null,
    },
    canReview: true,
    blockReason: null,
    ...overrides,
  });
}

export function makeInstructorReview(overrides: Partial<InstructorReview> = {}): InstructorReview {
  return InstructorReviewSchema.parse({
    id: LEARNING_FIXTURE_IDS.review,
    courseId: FIXTURE_IDS.course,
    rating: 4,
    body: 'Good, but the audio could be louder.',
    author: { id: FIXTURE_IDS.student, displayName: 'Jane Student' },
    state: 'PUBLISHED',
    createdAt: FIXTURE_NOW,
    editedAt: null,
    reply: null,
    ...overrides,
  });
}

export function makeQuestion(overrides: Partial<Question> = {}): Question {
  return QuestionSchema.parse({
    id: LEARNING_FIXTURE_IDS.question,
    courseId: FIXTURE_IDS.course,
    lectureId: LEARNING_FIXTURE_IDS.lectureVideo,
    title: 'Why does const allow mutating objects?',
    bodyMd: 'I can still push to a `const` array. Why?',
    author: { id: FIXTURE_IDS.student, displayName: 'Jane Student' },
    byInstructor: false,
    mine: true,
    upvoteCount: 2,
    answerCount: 1,
    acceptedAnswerId: null,
    resolved: false,
    voted: false,
    hidden: false,
    deleted: false,
    createdAt: FIXTURE_NOW,
    editedAt: null,
    lastActivityAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return AnswerSchema.parse({
    id: LEARNING_FIXTURE_IDS.answer,
    questionId: LEARNING_FIXTURE_IDS.question,
    bodyMd: '`const` freezes the binding, not the value.',
    author: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    byInstructor: true,
    mine: false,
    upvoteCount: 3,
    voted: false,
    accepted: false,
    hidden: false,
    deleted: false,
    createdAt: FIXTURE_NOW,
    editedAt: null,
    ...overrides,
  });
}

export function makeQuestionDetail(overrides: Partial<QuestionDetail> = {}): QuestionDetail {
  return QuestionDetailSchema.parse({
    ...makeQuestion(),
    answers: { items: [makeAnswer()], nextCursor: null },
    ...overrides,
  });
}

export function makeAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return AnnouncementSchema.parse({
    id: LEARNING_FIXTURE_IDS.announcement,
    courseId: FIXTURE_IDS.course,
    title: 'New section on generics',
    bodyMd: 'I added **five** lectures about generics.',
    author: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    sendEmail: true,
    createdAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeWishlistItem(overrides: Partial<WishlistItem> = {}): WishlistItem {
  return WishlistItemSchema.parse({
    courseId: FIXTURE_IDS.course2,
    slug: 'postgres-in-depth',
    title: 'PostgreSQL in Depth',
    instructor: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
    hasThumbnail: false,
    available: true,
    addedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeReport(overrides: Partial<Report> = {}): Report {
  return ReportSchema.parse({
    id: LEARNING_FIXTURE_IDS.report,
    subjectType: 'REVIEW',
    subjectId: LEARNING_FIXTURE_IDS.review,
    reason: 'SPAM',
    comment: null,
    status: 'OPEN',
    createdAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeModerationQueueItem(
  overrides: Partial<ModerationQueueItem> = {},
): ModerationQueueItem {
  return ModerationQueueItemSchema.parse({
    subjectType: 'REVIEW',
    subjectId: LEARNING_FIXTURE_IDS.review,
    courseId: FIXTURE_IDS.course,
    courseTitle: 'Complete TypeScript',
    moderationStatus: 'VISIBLE',
    openReportCount: 1,
    actions: [],
    preview: {
      title: null,
      body: 'Buy cheap followers at example.com',
      bodyIsMarkdown: false,
      rating: 1,
      author: { id: FIXTURE_IDS.student, displayName: 'Jane Student' },
      createdAt: FIXTURE_NOW,
      deleted: false,
    },
    reports: [
      {
        ...makeReport(),
        reporter: { id: FIXTURE_IDS.instructor, displayName: 'Ada Instructor' },
        resolvedAt: null,
      },
    ],
    lastReportedAt: FIXTURE_NOW,
    ...overrides,
  });
}

/* ----------------------------------------------------------------------------------------
 * Notifications and realtime
 * -------------------------------------------------------------------------------------- */

/** Default: a QA_NEW_ANSWER for the student app. Pass a full `{ kind, payload }` to change it. */
export function makeNotification(overrides: Partial<Notification> = {}): Notification {
  const kind = overrides.kind ?? 'QA_NEW_ANSWER';
  const meta = NOTIFICATION_KIND_META[kind];
  return NotificationSchema.parse({
    id: LEARNING_FIXTURE_IDS.notification,
    kind,
    app: meta.apps[0],
    category: meta.category,
    subjectType: meta.subjectType,
    subjectId: meta.subjectType === null ? null : LEARNING_FIXTURE_IDS.answer,
    createdAt: FIXTURE_NOW,
    readAt: null,
    payload: {
      questionId: LEARNING_FIXTURE_IDS.question,
      answerId: LEARNING_FIXTURE_IDS.answer,
      courseId: FIXTURE_IDS.course,
      courseTitle: 'Complete TypeScript',
      questionTitle: 'Why does const allow mutating objects?',
      authorName: 'Ada Instructor',
      byInstructor: true,
      excerpt: '`const` freezes the binding, not the value.',
      redacted: false,
    },
    ...overrides,
  });
}

export function makeUnreadCount(count = 3): UnreadCount {
  const capped = Math.min(count, UNREAD_COUNT_CAP);
  return UnreadCountSchema.parse({ count: capped, capped: capped >= UNREAD_COUNT_CAP });
}

/** Every pair at its code default. */
export function makeNotificationPreferences(): NotificationPreferences {
  return NotificationPreferencesSchema.parse({
    items: NOTIFICATION_CATEGORIES.flatMap((category) =>
      NOTIFICATION_CHANNELS.map((channel) => ({
        category,
        channel,
        enabled: NOTIFICATION_CATEGORY_META[category].defaults[channel],
        locked: NOTIFICATION_CATEGORY_META[category].locked.includes(channel),
        isDefault: true,
      })),
    ),
  });
}

export function makeRealtimeTicket(overrides: Partial<RealtimeTicket> = {}): RealtimeTicket {
  return RealtimeTicketSchema.parse({
    ticket: 'A'.repeat(43),
    url: 'http://127.0.0.1:3001',
    expiresAt: '2026-10-10T12:00:30.000Z',
    ...overrides,
  });
}
