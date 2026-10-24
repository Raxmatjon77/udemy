import { describe, expect, it } from 'vitest';
import * as events from './index';
import type { EventDefinition } from './define-event';
import {
  ENGAGEMENT_ANNOUNCEMENT_AGGREGATE,
  ENGAGEMENT_ANNOUNCEMENT_EVENTS,
  ENGAGEMENT_COURSE_REVIEW_AGGREGATE,
  ENGAGEMENT_COURSE_REVIEW_EVENTS,
  ENGAGEMENT_QUESTION_AGGREGATE,
  ENGAGEMENT_QUESTION_EVENTS,
  QuestionResolved,
  ReviewEdited,
  ReviewPosted,
} from './engagement';
import {
  CertificateIssued,
  CertificateReinstated,
  CertificateRevoked,
  LEARNING_CERTIFICATE_AGGREGATE,
  LEARNING_CERTIFICATE_EVENTS,
  LEARNING_PROGRESS_AGGREGATE,
  LEARNING_PROGRESS_EVENTS,
  LectureCompleted,
} from './learning';

const uuid = (n: number) => `0199c9a1-7d2e-7c4a-9b1e-${String(n).padStart(12, '0')}`;
const [userId, courseId, lectureId, revisionId, certificateId, adminId] = [1, 2, 3, 4, 5, 6].map(
  uuid,
) as [string, string, string, string, string, string];
const [reviewId, questionId, answerId, announcementId, attemptId] = [7, 8, 9, 10, 11].map(uuid) as [
  string,
  string,
  string,
  string,
  string,
];
const at = '2026-10-23T12:00:00.000Z';

/** One valid sample payload per Phase 5 event; the keys double as the full event list. */
const SAMPLES: Record<string, unknown> = {
  LectureCompleted: {
    userId,
    courseId,
    lectureId,
    lectureType: 'VIDEO',
    revisionId,
    cause: 'VIDEO_WATCHED',
    completedAt: at,
  },
  LectureCompletionCleared: { userId, courseId, lectureId, clearedAt: at },
  CourseCompleted: { userId, courseId, revisionId, lectureCount: 12, completedAt: at },
  QuizAttemptGraded: {
    attemptId,
    userId,
    courseId,
    lectureId,
    revisionId,
    scorePct: 80,
    passed: true,
    gradedAt: at,
  },
  CertificateIssued: {
    certificateId,
    userId,
    courseId,
    actorId: null,
    cause: 'COURSE_COMPLETED',
    issuedAt: at,
  },
  CertificateRevoked: {
    certificateId,
    userId,
    courseId,
    actorId: null,
    cause: 'ENROLLMENT_REVOKED',
    revokedAt: at,
  },
  CertificateReinstated: {
    certificateId,
    userId,
    courseId,
    actorId: adminId,
    cause: 'ADMIN',
    reinstatedAt: at,
  },
  ReviewPosted: { reviewId, courseId, userId, rating: 5, previousRating: null, postedAt: at },
  ReviewEdited: { reviewId, courseId, userId, rating: 3, previousRating: 5, editedAt: at },
  ReviewDeleted: { reviewId, courseId, actorId: userId, deletedAt: at },
  ReviewHidden: { reviewId, courseId, actorId: null, hiddenAt: at },
  ReviewRestored: { reviewId, courseId, actorId: adminId, restoredAt: at },
  ReviewReplyPosted: { reviewId, courseId, authorId: userId, postedAt: at },
  ReviewReplyEdited: { reviewId, courseId, authorId: userId, editedAt: at },
  ReviewReplyDeleted: { reviewId, courseId, authorId: userId, deletedAt: at },
  ReviewReplyHidden: { reviewId, courseId, authorId: userId, actorId: null, hiddenAt: at },
  ReviewReplyRestored: { reviewId, courseId, authorId: userId, actorId: adminId, restoredAt: at },
  QuestionPosted: { questionId, courseId, lectureId: null, authorId: userId, postedAt: at },
  AnswerPosted: {
    answerId,
    questionId,
    courseId,
    authorId: adminId,
    questionAuthorId: userId,
    byCourseOwner: true,
    postedAt: at,
  },
  QuestionResolved: { questionId, courseId, answerId, actorId: userId, resolvedAt: at },
  QuestionReopened: { questionId, courseId, answerId, actorId: null, reopenedAt: at },
  QuestionHidden: { questionId, courseId, actorId: null, hiddenAt: at },
  QuestionRestored: { questionId, courseId, actorId: adminId, restoredAt: at },
  QuestionDeleted: { questionId, courseId, actorId: userId, deletedAt: at },
  AnswerHidden: { answerId, questionId, courseId, actorId: adminId, hiddenAt: at },
  AnswerRestored: { answerId, questionId, courseId, actorId: adminId, restoredAt: at },
  AnswerDeleted: { answerId, questionId, courseId, actorId: userId, deletedAt: at },
  AnnouncementPosted: {
    announcementId,
    courseId,
    authorId: adminId,
    sendEmail: true,
    postedAt: at,
  },
  AnnouncementDeleted: {
    announcementId,
    courseId,
    authorId: adminId,
    sendEmail: true,
    actorId: adminId,
    deletedAt: at,
  },
};

const TOPICS: [string, readonly EventDefinition[]][] = [
  [LEARNING_PROGRESS_AGGREGATE, LEARNING_PROGRESS_EVENTS],
  [LEARNING_CERTIFICATE_AGGREGATE, LEARNING_CERTIFICATE_EVENTS],
  [ENGAGEMENT_COURSE_REVIEW_AGGREGATE, ENGAGEMENT_COURSE_REVIEW_EVENTS],
  [ENGAGEMENT_QUESTION_AGGREGATE, ENGAGEMENT_QUESTION_EVENTS],
  [ENGAGEMENT_ANNOUNCEMENT_AGGREGATE, ENGAGEMENT_ANNOUNCEMENT_EVENTS],
];
const ALL = TOPICS.flatMap(([, defs]) => defs);

describe('Phase 5 events (design §7)', () => {
  it('cover the five topics, each v1 and registered in the events index', () => {
    expect(TOPICS.map(([topic]) => topic)).toEqual([
      'learning.progress',
      'learning.certificate',
      'engagement.course_review',
      'engagement.question',
      'engagement.announcement',
    ]);
    expect(ALL.map((d) => d.type).sort()).toEqual(Object.keys(SAMPLES).sort());
    const exported = new Set<unknown>(Object.values(events));
    for (const [topic, defs] of TOPICS) {
      for (const def of defs) {
        expect(def.aggregateType, def.type).toBe(topic);
        expect(def.version).toBe(1);
        expect(def.qualifiedType).toBe(`${def.type}.v1`);
        expect(exported.has(def), def.type).toBe(true);
      }
    }
  });

  it.each(ALL.map((d) => [d.type, d] as const))('%s accepts its sample', (type, def) => {
    expect(def.parsePayload(SAMPLES[type])).toEqual(SAMPLES[type]);
    expect(def.matches({ eventType: type, version: 1 })).toBe(true);
    expect(def.matches({ eventType: type, version: 2 })).toBe(false);
  });

  it('carry no user-authored text or names', () => {
    const forbidden = /title|body|name|comment|reason|text|excerpt|^email$/i;
    for (const def of ALL) {
      const keys = Object.keys(def.parsePayload(SAMPLES[def.type]) as object);
      for (const key of keys) expect(key, `${def.type}.${key}`).not.toMatch(forbidden);
    }
  });

  it('enforce the lecture type / cause rule (D4)', () => {
    const sample = SAMPLES.LectureCompleted as Record<string, unknown>;
    expect(LectureCompleted.safeParsePayload({ ...sample, cause: 'MANUAL' }).success).toBe(false);
    expect(
      LectureCompleted.safeParsePayload({ ...sample, lectureType: 'ARTICLE', cause: 'MANUAL' })
        .success,
    ).toBe(true);
    expect(
      LectureCompleted.safeParsePayload({ ...sample, lectureType: 'QUIZ', cause: 'QUIZ_PASSED' })
        .success,
    ).toBe(true);
  });

  it('certificate transitions carry an actor exactly for ADMIN causes', () => {
    const issued = SAMPLES.CertificateIssued as Record<string, unknown>;
    expect(CertificateIssued.safeParsePayload({ ...issued, actorId: adminId }).success).toBe(false);
    const revoked = SAMPLES.CertificateRevoked as Record<string, unknown>;
    expect(CertificateRevoked.safeParsePayload({ ...revoked, cause: 'ADMIN' }).success).toBe(false);
    expect(
      CertificateRevoked.safeParsePayload({ ...revoked, cause: 'ENROLLMENT_REGRANTED' }).success,
    ).toBe(false);
    const reinstated = SAMPLES.CertificateReinstated as Record<string, unknown>;
    expect(
      CertificateReinstated.safeParsePayload({ ...reinstated, cause: 'ENROLLMENT_REGRANTED' })
        .success,
    ).toBe(false);
  });

  it('review and Q&A specifics', () => {
    const posted = SAMPLES.ReviewPosted as Record<string, unknown>;
    expect(ReviewPosted.safeParsePayload({ ...posted, previousRating: 4 }).success).toBe(false);
    const edited = SAMPLES.ReviewEdited as Record<string, unknown>;
    expect(ReviewEdited.safeParsePayload({ ...edited, rating: 6 }).success).toBe(false);
    const resolved = SAMPLES.QuestionResolved as Record<string, unknown>;
    expect(QuestionResolved.safeParsePayload({ ...resolved, answerId: null }).success).toBe(false);
  });
});
