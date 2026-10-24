import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  isPreferenceLocked,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  NOTIFICATION_KIND_META,
  NOTIFICATION_KINDS,
  NOTIFICATION_PAYLOAD_SCHEMAS,
  NotificationContentSchema,
  parseNotificationPayload,
  redactNotificationPayload,
} from '../notifications/notification-kinds';
import {
  CourseRoomAckSchema,
  parseRealtimeServerEvent,
  REALTIME_SERVER_EVENT_SCHEMAS,
  REALTIME_SERVER_EVENTS,
  realtimeCourseRoom,
  realtimeUserRoom,
  RealtimeHandshakeAuthSchema,
  RealtimeTicketSchema,
} from '../realtime';
import { LECTURE_TYPES, LectureTypeSchema, PREVIEWABLE_LECTURE_TYPES } from './catalog';
import { COURSE_READINESS_ISSUE_CODES, LectureSchema } from './courses';
import {
  AnnouncementLimitProblemSchema,
  InstructorAnnouncementPageSchema,
  PostAnnouncementRequestSchema,
  WishlistStatesQuerySchema,
} from './engagement-community';
import {
  ModerationQueueQuerySchema,
  ModerationReasonRequestSchema,
  REPORT_SUBJECT_PATHS,
  REPORT_SUBJECT_TYPES,
  ReportContentRequestSchema,
  reportSubjectTypeOfPath,
} from './engagement-moderation';
import {
  AskQuestionRequestSchema,
  EditQuestionRequestSchema,
  InstructorQaQuerySchema,
  QuestionsQuerySchema,
} from './engagement-qa';
import {
  CourseRatingSchema,
  MyCourseReviewSchema,
  PublicReviewsQuerySchema,
  ratingAverage,
  RatingsQuerySchema,
  UpsertReviewRequestSchema,
} from './engagement-reviews';
import {
  CERTIFICATE_CODE_PATTERN,
  CertificateCodeSchema,
  CertificateSchema,
  CLIENT_COMPLETION_CAUSES,
  CompleteLectureRequestSchema,
  CompletionStateSchema,
  CourseProgressSchema,
  CreateNoteRequestSchema,
  isCompletionCauseAllowed,
  LECTURE_COMPLETION_CAUSES,
  LECTURE_COMPLETION_CAUSES_BY_TYPE,
  MANUALLY_COMPLETABLE_LECTURE_TYPES,
  NotesQuerySchema,
  progressPct,
  QuizAttemptDetailSchema,
  QuizAttemptQuestionSchema,
  QuizAttemptSchema,
  QuizResultSchema,
  RecordHeartbeatRequestSchema,
  SubmitQuizAttemptRequestSchema,
  UpdateNoteRequestSchema,
} from './learning';
import {
  NotificationSchema,
  NotificationsQuerySchema,
  UnreadCountSchema,
  UpdateNotificationPreferencesRequestSchema,
  UnsubscribeRequestSchema,
} from './notifications';
import {
  CreateQuizQuestionRequestSchema,
  isQuizQuestionComplete,
  PutQuizQuestionOptionsRequestSchema,
  QUIZ_LIMITS,
  QuizAuthoringSchema,
  ReorderQuizQuestionsRequestSchema,
  RevisionQuizSchema,
  UpdateQuizQuestionRequestSchema,
} from './quiz';

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const uuid = (n: number) => `0199c9a1-7d2e-7c4a-9b1e-${String(n).padStart(12, '0')}`;
const at = '2026-10-23T10:00:00.000Z';

describe('QUIZ lecture type (D6)', () => {
  it('is a lecture type that has no media and is never a preview', () => {
    expect(LECTURE_TYPES).toEqual(['VIDEO', 'ARTICLE', 'RESOURCE', 'QUIZ']);
    expect(LectureTypeSchema.parse('QUIZ')).toBe('QUIZ');
    expect(PREVIEWABLE_LECTURE_TYPES).not.toContain('QUIZ');
    expect(COURSE_READINESS_ISSUE_CODES).toEqual(
      expect.arrayContaining(['QUIZ_EMPTY', 'QUIZ_QUESTION_INVALID']),
    );
  });

  it('Lecture.quiz is optional and nullable (additive)', () => {
    const lecture = {
      id: uuid(1),
      sectionId: uuid(2),
      type: 'QUIZ',
      title: 'Check',
      descriptionMd: null,
      isPreview: false,
      position: 0,
      mediaAssetId: null,
      asset: null,
      articleLength: null,
      updatedAt: at,
    };
    expect(ok(LectureSchema, lecture)).toBe(true);
    expect(ok(LectureSchema, { ...lecture, quiz: null })).toBe(true);
    expect(ok(LectureSchema, { ...lecture, quiz: { passPct: 70, questionCount: 3 } })).toBe(true);
    expect(ok(LectureSchema, { ...lecture, quiz: { passPct: 0, questionCount: 3 } })).toBe(false);
  });
});

describe('quiz authoring', () => {
  it('bounds questions and options', () => {
    expect(ok(CreateQuizQuestionRequestSchema, { kind: 'SINGLE_CHOICE', promptMd: 'Q?' })).toBe(
      true,
    );
    expect(ok(CreateQuizQuestionRequestSchema, { kind: 'TRUE_FALSE', promptMd: 'Q?' })).toBe(false);
    expect(ok(CreateQuizQuestionRequestSchema, { kind: 'SINGLE_CHOICE', promptMd: '' })).toBe(
      false,
    );
    expect(ok(UpdateQuizQuestionRequestSchema, {})).toBe(false);
    expect(ok(UpdateQuizQuestionRequestSchema, { explanationMd: null })).toBe(true);
    const option = (text: string, isCorrect = false) => ({ text, isCorrect });
    expect(ok(PutQuizQuestionOptionsRequestSchema, { options: [option('a', true)] })).toBe(false);
    expect(
      ok(PutQuizQuestionOptionsRequestSchema, { options: [option('a', true), option('b')] }),
    ).toBe(true);
    expect(
      ok(PutQuizQuestionOptionsRequestSchema, {
        options: Array.from({ length: 7 }, (_, i) => option(`o${i}`)),
      }),
    ).toBe(false);
    expect(
      ok(PutQuizQuestionOptionsRequestSchema, { options: [option('Same'), option('same')] }),
    ).toBe(false);
    expect(ok(ReorderQuizQuestionsRequestSchema, { questionIds: [uuid(1), uuid(1)] })).toBe(false);
  });

  it('readiness rule per question kind', () => {
    const opts = (...correct: boolean[]) => correct.map((isCorrect) => ({ isCorrect }));
    expect(isQuizQuestionComplete('SINGLE_CHOICE', opts(true, false))).toBe(true);
    expect(isQuizQuestionComplete('SINGLE_CHOICE', opts(true, true))).toBe(false);
    expect(isQuizQuestionComplete('SINGLE_CHOICE', opts(true))).toBe(false);
    expect(isQuizQuestionComplete('MULTIPLE_CHOICE', opts(true, true, false))).toBe(true);
    expect(isQuizQuestionComplete('MULTIPLE_CHOICE', opts(false, false))).toBe(false);
    expect(QUIZ_LIMITS).toEqual({
      maxQuestions: 50,
      minOptions: 2,
      maxOptions: 6,
      defaultPassPct: 70,
    });
  });

  it('authoring and revision schemas carry the keys', () => {
    expect(Object.keys(QuizAuthoringSchema.shape)).toContain('questions');
    const question = RevisionQuizSchema.shape.questions.element;
    expect(Object.keys(question.shape.options.element.shape)).toContain('isCorrect');
    expect(Object.keys(question.shape)).toContain('explanationMd');
  });
});

describe('learning', () => {
  it('completion causes match the lecture type (D4)', () => {
    expect(LECTURE_COMPLETION_CAUSES_BY_TYPE).toEqual({
      VIDEO: ['VIDEO_WATCHED'],
      ARTICLE: ['ARTICLE_READ', 'MANUAL'],
      RESOURCE: ['RESOURCE_OPENED', 'MANUAL'],
      QUIZ: ['QUIZ_PASSED'],
    });
    for (const type of LECTURE_TYPES) {
      for (const cause of LECTURE_COMPLETION_CAUSES) {
        const manual = cause === 'MANUAL';
        if (manual) {
          expect(isCompletionCauseAllowed(type, cause)).toBe(
            (MANUALLY_COMPLETABLE_LECTURE_TYPES as readonly string[]).includes(type),
          );
        }
      }
    }
    expect(CLIENT_COMPLETION_CAUSES).toEqual(['ARTICLE_READ', 'RESOURCE_OPENED', 'MANUAL']);
    expect(ok(CompleteLectureRequestSchema, { cause: 'VIDEO_WATCHED' })).toBe(false);
    expect(ok(CompleteLectureRequestSchema, { cause: 'MANUAL' })).toBe(true);
  });

  it('heartbeats: whole seconds, to > from, at most 32 ranges', () => {
    expect(ok(RecordHeartbeatRequestSchema, { positionSeconds: 10, ranges: [] })).toBe(true);
    expect(
      ok(RecordHeartbeatRequestSchema, { positionSeconds: 10, ranges: [{ from: 0, to: 10 }] }),
    ).toBe(true);
    expect(
      ok(RecordHeartbeatRequestSchema, { positionSeconds: 10, ranges: [{ from: 5, to: 5 }] }),
    ).toBe(false);
    expect(ok(RecordHeartbeatRequestSchema, { positionSeconds: 1.5, ranges: [] })).toBe(false);
    expect(
      ok(RecordHeartbeatRequestSchema, {
        positionSeconds: 0,
        ranges: Array.from({ length: 33 }, (_, i) => ({ from: i, to: i + 1 })),
      }),
    ).toBe(false);
  });

  it('progress is the floored percentage of live lectures (D5)', () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(2, 3)).toBe(66);
    expect(progressPct(3, 3)).toBe(100);
    expect(progressPct(4, 3)).toBe(100);
    expect(ok(CourseProgressSchema, { completed: 4, total: 3, pct: 100 })).toBe(false);
    expect(
      ok(CompletionStateSchema, {
        lectureId: uuid(1),
        completed: true,
        cause: null,
        completedAt: null,
        progress: { completed: 1, total: 2, pct: 50 },
        courseCompletedAt: null,
      }),
    ).toBe(false);
  });

  it('notes: markdown ≤ 2000, optional lecture filter, PATCH needs a field', () => {
    expect(ok(CreateNoteRequestSchema, { lectureId: uuid(1), bodyMd: 'x' })).toBe(true);
    expect(ok(CreateNoteRequestSchema, { lectureId: uuid(1), bodyMd: 'x'.repeat(2001) })).toBe(
      false,
    );
    expect(NotesQuerySchema.parse({ lectureId: '' })).toEqual({ limit: 20 });
    expect(ok(UpdateNoteRequestSchema, {})).toBe(false);
    expect(ok(UpdateNoteRequestSchema, { positionSeconds: null })).toBe(true);
  });

  it('attempt questions carry no correctness fields, and parsing strips any', () => {
    expect(Object.keys(QuizAttemptQuestionSchema.shape).sort()).toEqual(
      ['id', 'kind', 'options', 'position', 'promptMd'].sort(),
    );
    const leaky = {
      id: uuid(1),
      position: 0,
      kind: 'SINGLE_CHOICE',
      promptMd: 'Q?',
      explanationMd: 'secret',
      correct: [1],
      options: [
        { position: 0, text: 'a', isCorrect: false },
        { position: 1, text: 'b', isCorrect: true },
      ],
    };
    const parsed = QuizAttemptQuestionSchema.parse(leaky);
    expect(JSON.stringify(parsed)).not.toMatch(/isCorrect|correct|explanation/);
    expect(Object.keys(QuizAttemptSchema.shape)).not.toContain('result');
  });

  it('results reveal keys only when `revealed`, and passed follows the score', () => {
    const result = {
      attemptId: uuid(1),
      courseId: uuid(2),
      lectureId: uuid(3),
      scorePct: 50,
      correctCount: 1,
      questionCount: 2,
      passPct: 70,
      passed: false,
      revealed: false,
      submittedAt: at,
      questions: [
        {
          questionId: uuid(4),
          position: 0,
          selectedOptions: [0],
          yourAnswerCorrect: true,
          correctOptions: null,
          explanationMd: null,
        },
        {
          questionId: uuid(5),
          position: 1,
          selectedOptions: [],
          yourAnswerCorrect: false,
          correctOptions: null,
          explanationMd: null,
        },
      ],
    };
    expect(ok(QuizResultSchema, result)).toBe(true);
    const leak = structuredClone(result);
    leak.questions[0]!.correctOptions = [0] as unknown as null;
    expect(ok(QuizResultSchema, leak)).toBe(false);
    expect(ok(QuizResultSchema, { ...result, passed: true })).toBe(false);
    expect(
      ok(QuizAttemptDetailSchema, {
        id: uuid(1),
        courseId: uuid(2),
        lectureId: uuid(3),
        revisionId: uuid(6),
        status: 'IN_PROGRESS',
        passPct: 70,
        questionCount: 1,
        startedAt: at,
        submittedAt: null,
        abandonedAt: null,
        questions: [
          {
            id: uuid(4),
            position: 0,
            kind: 'SINGLE_CHOICE',
            promptMd: 'Q?',
            options: [
              { position: 0, text: 'a' },
              { position: 1, text: 'b' },
            ],
          },
        ],
        result,
      }),
    ).toBe(false);
  });

  it('submit answers: unique questions and positions, positions 0–5', () => {
    const answer = (questionId: string, optionPositions: number[]) => ({
      questionId,
      optionPositions,
    });
    expect(ok(SubmitQuizAttemptRequestSchema, { answers: [answer(uuid(1), [0, 2])] })).toBe(true);
    expect(ok(SubmitQuizAttemptRequestSchema, { answers: [answer(uuid(1), [6])] })).toBe(false);
    expect(ok(SubmitQuizAttemptRequestSchema, { answers: [answer(uuid(1), [1, 1])] })).toBe(false);
    expect(
      ok(SubmitQuizAttemptRequestSchema, { answers: [answer(uuid(1), []), answer(uuid(1), [0])] }),
    ).toBe(false);
  });

  it('certificate codes are 26 Crockford base32 characters', () => {
    expect(CERTIFICATE_CODE_PATTERN.test('01J9ZP4X6V8Q2M3N5R7T9W0Y1A')).toBe(true);
    expect(ok(CertificateCodeSchema, '01J9ZP4X6V8Q2M3N5R7T9W0Y1I')).toBe(false); // I is excluded
    expect(ok(CertificateCodeSchema, '01j9zp4x6v8q2m3n5r7t9w0y1a')).toBe(false);
    expect(ok(CertificateCodeSchema, '01J9ZP4X6V8Q2M3N5R7T9W0Y1')).toBe(false);
    const certificate = {
      id: uuid(1),
      code: '01J9ZP4X6V8Q2M3N5R7T9W0Y1A',
      courseId: uuid(2),
      courseSlug: 'x',
      courseTitle: 'T',
      recipientName: 'R',
      instructorName: 'I',
      status: 'REVOKED',
      issuedAt: at,
      revokedAt: null,
      pdfReady: true,
    };
    expect(ok(CertificateSchema, certificate)).toBe(false);
    expect(ok(CertificateSchema, { ...certificate, revokedAt: at })).toBe(true);
  });
});

describe('engagement', () => {
  it('reviews: rating 1–5, optional plain-text body', () => {
    expect(ok(UpsertReviewRequestSchema, { rating: 5 })).toBe(true);
    expect(ok(UpsertReviewRequestSchema, { rating: 5, body: null })).toBe(true);
    expect(ok(UpsertReviewRequestSchema, { rating: 0 })).toBe(false);
    expect(ok(UpsertReviewRequestSchema, { rating: 4.5 })).toBe(false);
    expect(ok(UpsertReviewRequestSchema, { rating: 5, body: 'x'.repeat(2001) })).toBe(false);
    expect(ok(UpsertReviewRequestSchema, { rating: 5, body: 'bad\u0007' })).toBe(false);
    expect(PublicReviewsQuerySchema.parse({ rating: '4', cursor: '' })).toEqual({
      rating: 4,
      limit: 20,
    });
    expect(
      ok(RatingsQuerySchema, {
        courseIds: Array.from({ length: 49 }, (_, i) => uuid(i)).join(','),
      }),
    ).toBe(false);
  });

  it('averages round half up to one decimal; the histogram sums to count', () => {
    expect(ratingAverage({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 })).toBeNull();
    expect(ratingAverage({ '1': 0, '2': 0, '3': 0, '4': 1, '5': 1 })).toBe('4.5');
    expect(ratingAverage({ '1': 0, '2': 0, '3': 0, '4': 2, '5': 1 })).toBe('4.3');
    expect(ratingAverage({ '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 })).toBe('4.7');
    expect(ratingAverage({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 3 })).toBe('5.0');
    const histogram = { '1': 0, '2': 0, '3': 0, '4': 1, '5': 1 };
    expect(ok(CourseRatingSchema, { courseId: uuid(1), average: '4.5', count: 2, histogram })).toBe(
      true,
    );
    expect(ok(CourseRatingSchema, { courseId: uuid(1), average: '4.5', count: 3, histogram })).toBe(
      false,
    );
    expect(
      ok(CourseRatingSchema, { courseId: uuid(1), average: '4.50', count: 2, histogram }),
    ).toBe(false);
  });

  it('the review dialog state has a reason exactly when blocked', () => {
    const base = { courseId: uuid(1), review: null };
    expect(ok(MyCourseReviewSchema, { ...base, canReview: true, blockReason: null })).toBe(true);
    expect(
      ok(MyCourseReviewSchema, { ...base, canReview: false, blockReason: 'review_not_eligible' }),
    ).toBe(true);
    expect(ok(MyCourseReviewSchema, { ...base, canReview: false, blockReason: null })).toBe(false);
  });

  it('Q&A queries and bodies', () => {
    expect(QuestionsQuerySchema.parse({})).toEqual({ limit: 20, sort: 'recent' });
    expect(ok(QuestionsQuerySchema, { q: 'ab' })).toBe(false);
    expect(ok(QuestionsQuerySchema, { sort: 'oldest' })).toBe(false);
    expect(InstructorQaQuerySchema.parse({ status: '' }).status).toBe('unanswered');
    expect(ok(AskQuestionRequestSchema, { title: 'Why?', bodyMd: 'x' })).toBe(false);
    expect(ok(AskQuestionRequestSchema, { title: 'Why is this?', bodyMd: 'x' })).toBe(true);
    expect(
      ok(AskQuestionRequestSchema, { title: 'Why is this?', bodyMd: 'x'.repeat(10_001) }),
    ).toBe(false);
    expect(ok(EditQuestionRequestSchema, {})).toBe(false);
  });

  it('announcements: limits, quota page and the limit problem', () => {
    expect(PostAnnouncementRequestSchema.parse({ title: 'Hello all', bodyMd: 'x' }).sendEmail).toBe(
      false,
    );
    expect(ok(PostAnnouncementRequestSchema, { title: 'Hi', bodyMd: 'x' })).toBe(false);
    expect(
      ok(InstructorAnnouncementPageSchema, {
        items: [],
        nextCursor: null,
        quota: { limit: 4, used: 4, windowDays: 30, nextAvailableAt: at },
      }),
    ).toBe(true);
    expect(
      ok(AnnouncementLimitProblemSchema, {
        type: 'about:blank',
        title: 't',
        status: 422,
        code: 'announcement_limit_exceeded',
        retryAt: at,
      }),
    ).toBe(true);
    expect(ok(WishlistStatesQuerySchema, { courseIds: '' })).toBe(false);
  });

  it('reports and moderation', () => {
    for (const type of REPORT_SUBJECT_TYPES) {
      expect(reportSubjectTypeOfPath(REPORT_SUBJECT_PATHS[type])).toBe(type);
    }
    expect(reportSubjectTypeOfPath('announcements')).toBeNull();
    expect(ok(ReportContentRequestSchema, { reason: 'SPAM' })).toBe(true);
    expect(ok(ReportContentRequestSchema, { reason: 'SPAM', comment: 'x'.repeat(501) })).toBe(
      false,
    );
    expect(ok(ReportContentRequestSchema, { reason: 'BORING' })).toBe(false);
    expect(ModerationQueueQuerySchema.parse({}).status).toBe('OPEN');
    expect(ok(ModerationReasonRequestSchema, { reason: 'too short' })).toBe(false);
    expect(ok(ModerationReasonRequestSchema, { reason: 'Spam link to a scam site' })).toBe(true);
  });
});

describe('notifications', () => {
  const answerPayload = {
    questionId: uuid(1),
    answerId: uuid(2),
    courseId: uuid(3),
    courseTitle: 'Complete TypeScript',
    questionTitle: 'Why?',
    authorName: 'Ada',
    byInstructor: true,
    excerpt: 'Because',
    redacted: false,
  };

  it('every kind has metadata, a payload schema and a valid category', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_PAYLOAD_SCHEMAS[kind], kind).toBeDefined();
      expect(NOTIFICATION_CATEGORIES).toContain(NOTIFICATION_KIND_META[kind].category);
      expect(NOTIFICATION_KIND_META[kind].apps.length).toBeGreaterThan(0);
    }
    expect(isPreferenceLocked('MODERATION', 'EMAIL')).toBe(true);
    expect(isPreferenceLocked('QA', 'EMAIL')).toBe(false);
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(NOTIFICATION_CATEGORY_META[category].defaults).toHaveProperty('IN_APP');
    }
  });

  it('the inbox row is a union narrowed by kind', () => {
    const row = {
      id: uuid(9),
      kind: 'QA_NEW_ANSWER',
      app: 'STUDENT',
      category: 'QA',
      subjectType: 'ANSWER',
      subjectId: uuid(2),
      createdAt: at,
      readAt: null,
      payload: answerPayload,
    };
    const parsed = NotificationSchema.parse(row);
    if (parsed.kind === 'QA_NEW_ANSWER') expect(parsed.payload.byInstructor).toBe(true);
    expect(ok(NotificationSchema, { ...row, kind: 'REVIEW_NEW' })).toBe(false);
    expect(ok(NotificationSchema, { ...row, kind: 'NOPE' })).toBe(false);
  });

  it('redaction nulls the user-authored text, and a redacted payload cannot carry text', () => {
    const content = NotificationContentSchema.parse({
      kind: 'QA_NEW_ANSWER',
      payload: answerPayload,
    });
    const redacted = redactNotificationPayload(content);
    expect(redacted.payload).toMatchObject({ questionTitle: null, excerpt: null, redacted: true });
    expect(NotificationContentSchema.parse(redacted)).toEqual(redacted);
    expect(() =>
      parseNotificationPayload('QA_NEW_ANSWER', { ...answerPayload, redacted: true }),
    ).toThrow();
    const certificate = NotificationContentSchema.parse({
      kind: 'CERTIFICATE_ISSUED',
      payload: {
        certificateId: uuid(1),
        code: '01J9ZP4X6V8Q2M3N5R7T9W0Y1A',
        courseId: uuid(2),
        courseTitle: 'T',
      },
    });
    expect(redactNotificationPayload(certificate)).toBe(certificate);
  });

  it('queries, unread cap, preferences and unsubscribe', () => {
    expect(NotificationsQuerySchema.parse({}).unreadOnly).toBe(false);
    expect(NotificationsQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
    expect(ok(NotificationsQuerySchema, { unreadOnly: 'yes' })).toBe(false);
    expect(ok(UnreadCountSchema, { count: 100, capped: true })).toBe(true);
    expect(ok(UnreadCountSchema, { count: 99, capped: true })).toBe(false);
    expect(ok(UnreadCountSchema, { count: 101, capped: true })).toBe(false);
    const item = { category: 'QA', channel: 'EMAIL', enabled: false };
    expect(ok(UpdateNotificationPreferencesRequestSchema, { items: [item] })).toBe(true);
    expect(ok(UpdateNotificationPreferencesRequestSchema, { items: [item, item] })).toBe(false);
    expect(ok(UpdateNotificationPreferencesRequestSchema, { items: [] })).toBe(false);
    expect(ok(UnsubscribeRequestSchema, { token: '' })).toBe(false);
  });
});

describe('realtime', () => {
  it('ticket and handshake', () => {
    const ticket = { ticket: 'A'.repeat(43), url: 'https://rt.example.com', expiresAt: at };
    expect(ok(RealtimeTicketSchema, ticket)).toBe(true);
    expect(ok(RealtimeTicketSchema, { ...ticket, ticket: 'short' })).toBe(false);
    expect(ok(RealtimeTicketSchema, { ...ticket, url: 'ftp://rt.example.com' })).toBe(false);
    expect(ok(RealtimeHandshakeAuthSchema, { ticket: 'B'.repeat(43) })).toBe(true);
  });

  it('server events are id-only hints', () => {
    expect(Object.keys(REALTIME_SERVER_EVENT_SCHEMAS).sort()).toEqual(
      [...REALTIME_SERVER_EVENTS].sort(),
    );
    expect(
      parseRealtimeServerEvent('qa.changed', {
        courseId: uuid(1),
        questionId: uuid(2),
        lectureId: null,
      }),
    ).toEqual({ courseId: uuid(1), questionId: uuid(2), lectureId: null });
    expect(() => parseRealtimeServerEvent('notification.unread', { count: 101 })).toThrow();
    expect(() => parseRealtimeServerEvent('session.reauth', { extra: 1 })).toThrow();
    expect(
      parseRealtimeServerEvent('notification.created', {
        id: uuid(1),
        kind: 'MEDIA_READY',
        app: 'INSTRUCTOR',
      }),
    ).toMatchObject({ kind: 'MEDIA_READY' });
  });

  it('rooms and acks', () => {
    expect(realtimeUserRoom(uuid(1), 'STUDENT')).toBe(`u:${uuid(1)}:STUDENT`);
    expect(realtimeCourseRoom(uuid(2))).toBe(`c:${uuid(2)}`);
    expect(ok(CourseRoomAckSchema, { ok: true })).toBe(true);
    expect(ok(CourseRoomAckSchema, { ok: false, error: 'forbidden' })).toBe(true);
    expect(ok(CourseRoomAckSchema, { ok: false })).toBe(false);
  });
});
