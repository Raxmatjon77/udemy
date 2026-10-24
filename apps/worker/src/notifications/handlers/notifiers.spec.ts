import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_TRX } from '../../identity/testing/identity-mail.fakes';
import { NonRetryableError } from '../../messaging';
import { testHandlerContext } from '../../testing/handler-context';
import {
  type AnnouncementContext,
  type AnswerContext,
  type CertificateContext,
  type CourseContext,
  NotificationContextReader,
  type QuestionContext,
  type ReplyContext,
  type ReviewContext,
} from '../persistence/notification-context.reader';
import { type DelivererKit, delivererKit, FakeAdmins } from '../testing/notifications.fakes';
import { CertificateIssuedNotifier } from './certificate-notifier.handler';
import { MediaReadyNotifier } from './media-notifier.handlers';
import {
  AnnouncementDeletedNotifier,
  HiddenContentNotices,
  QuestionHiddenNotifier,
} from './moderation-notifier.handlers';
import {
  QaAnswerPostedNotifier,
  QaQuestionPostedNotifier,
  QaQuestionResolvedNotifier,
} from './qa-notifier.handlers';
import { ReviewEditedNotifier, ReviewReplyPostedNotifier } from './review-notifier.handlers';
import { RoomRevokerHandler } from './room-revoker.handler';

const OWNER = '01900000-0000-7000-8000-0000000000b1';
const STUDENT = '01900000-0000-7000-8000-0000000000a1';
const OTHER = '01900000-0000-7000-8000-0000000000a2';
const ADMIN = '01900000-0000-7000-8000-0000000000ad';
const COURSE = '01900000-0000-7000-8000-0000000000c1';
const QUESTION = '01900000-0000-7000-8000-0000000000d1';
const ANSWER = '01900000-0000-7000-8000-0000000000d2';
const REVIEW = '01900000-0000-7000-8000-0000000000d3';
const REPLY = '01900000-0000-7000-8000-0000000000d4';
const CERT = '01900000-0000-7000-8000-0000000000d5';
const ASSET = '01900000-0000-7000-8000-0000000000d6';
const ANNOUNCEMENT = '01900000-0000-7000-8000-0000000000d7';
const EVENT = '01900000-0000-7000-8000-0000000000e1';
const AT = '2026-10-24T10:00:00.000Z';
const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ0123';

function envelope(
  eventType: string,
  aggregateType: string,
  payload: unknown,
  version = 1,
): EventEnvelope {
  return {
    eventId: EVENT,
    eventType,
    aggregateType,
    aggregateId: COURSE,
    occurredAt: AT,
    version,
    payload,
  };
}

/** Row lookups from maps; everything else is absent. */
class FakeReader extends NotificationContextReader {
  courses = new Map<string, CourseContext>();
  names = new Map<string, string>();
  questions = new Map<string, QuestionContext>();
  answers = new Map<string, AnswerContext>();
  reviews = new Map<string, ReviewContext>();
  replies = new Map<string, ReplyContext>();
  certificates = new Map<string, CertificateContext>();
  announcements = new Map<string, AnnouncementContext>();
  reports = 3;

  override async course(_t: Transaction<DB>, id: string) {
    return this.courses.get(id) ?? null;
  }
  override async displayName(_t: Transaction<DB>, id: string) {
    return this.names.get(id) ?? null;
  }
  override async question(_t: Transaction<DB>, id: string) {
    return this.questions.get(id) ?? null;
  }
  override async answer(_t: Transaction<DB>, id: string) {
    return this.answers.get(id) ?? null;
  }
  override async answerIdsOf(_t: Transaction<DB>, questionId: string) {
    return [...this.answers.values()].filter((a) => a.questionId === questionId).map((a) => a.id);
  }
  override async review(_t: Transaction<DB>, id: string) {
    return this.reviews.get(id) ?? null;
  }
  override async liveReply(_t: Transaction<DB>, reviewId: string) {
    return [...this.replies.values()].find((r) => r.reviewId === reviewId) ?? null;
  }
  override async replyIdsOf(_t: Transaction<DB>, reviewId: string) {
    return [...this.replies.values()].filter((r) => r.reviewId === reviewId).map((r) => r.id);
  }
  override async certificate(_t: Transaction<DB>, id: string) {
    return this.certificates.get(id) ?? null;
  }
  override async announcement(_t: Transaction<DB>, id: string) {
    return this.announcements.get(id) ?? null;
  }
  override async assetFilename() {
    return 'intro.mp4';
  }
  override async reportCount() {
    return this.reports;
  }
}

let kit: DelivererKit;
let reader: FakeReader;

beforeEach(() => {
  kit = delivererKit();
  for (const id of [OWNER, STUDENT, OTHER, ADMIN]) kit.contacts.add(id);
  reader = new FakeReader();
  reader.courses.set(COURSE, { courseId: COURSE, ownerId: OWNER, title: 'Rust for beginners' });
  reader.names.set(STUDENT, 'Stu Dent').set(OWNER, 'Ina Structor').set(OTHER, 'Oth Er');
  reader.questions.set(QUESTION, {
    id: QUESTION,
    courseId: COURSE,
    authorId: STUDENT,
    title: 'How do lifetimes work?',
    visible: true,
  });
  reader.answers.set(ANSWER, {
    id: ANSWER,
    questionId: QUESTION,
    authorId: OTHER,
    bodyMd: 'Read **chapter 10**.',
    visible: true,
  });
});

describe('qa-notifier', () => {
  const posted = (authorId: string) =>
    envelope('QuestionPosted', 'engagement.question', {
      questionId: QUESTION,
      courseId: COURSE,
      lectureId: null,
      authorId,
      postedAt: AT,
    });

  it('QuestionPosted -> QA_NEW_QUESTION to the owner (instructor bell)', async () => {
    await new QaQuestionPostedNotifier(reader, kit.deliverer).handle(
      posted(STUDENT),
      FAKE_TRX,
      testHandlerContext(),
    );
    expect(kit.store.rows).toEqual([
      expect.objectContaining({
        userId: OWNER,
        app: 'INSTRUCTOR',
        kind: 'QA_NEW_QUESTION',
        subjectId: QUESTION,
        sourceEventId: EVENT,
        payload: expect.objectContaining({
          questionTitle: 'How do lifetimes work?',
          authorName: 'Stu Dent',
        }),
      }),
    ]);
    expect(kit.mailer.sent[0]?.subject).toBe('New question in "Rust for beginners"');
  });

  it('no notification when the owner asked, or the question is already hidden', async () => {
    await new QaQuestionPostedNotifier(reader, kit.deliverer).handle(
      posted(OWNER),
      FAKE_TRX,
      testHandlerContext(),
    );
    reader.questions.set(QUESTION, { ...reader.questions.get(QUESTION)!, visible: false });
    await new QaQuestionPostedNotifier(reader, kit.deliverer).handle(
      posted(STUDENT),
      FAKE_TRX,
      testHandlerContext(),
    );
    expect(kit.store.rows).toHaveLength(0);
  });

  it('refuses another event version (non-retryable)', async () => {
    const v2 = { ...posted(STUDENT), version: 2 };
    await expect(
      new QaQuestionPostedNotifier(reader, kit.deliverer).handle(
        v2,
        FAKE_TRX,
        testHandlerContext(),
      ),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  const answered = (authorId: string, questionAuthorId: string) =>
    envelope('AnswerPosted', 'engagement.question', {
      answerId: ANSWER,
      questionId: QUESTION,
      courseId: COURSE,
      authorId,
      questionAuthorId,
      byCourseOwner: authorId === OWNER,
      postedAt: AT,
    });

  it('AnswerPosted -> QA_NEW_ANSWER to the question author with a plain-text excerpt', async () => {
    await new QaAnswerPostedNotifier(reader, kit.deliverer).handle(
      answered(OTHER, STUDENT),
      FAKE_TRX,
      testHandlerContext(),
    );
    expect(kit.store.rows[0]).toMatchObject({
      userId: STUDENT,
      app: 'STUDENT',
      kind: 'QA_NEW_ANSWER',
      subjectId: ANSWER,
      payload: { excerpt: 'Read chapter 10.', byInstructor: false },
    });
  });

  it('an owner who asked gets it in the instructor bell; a self-answer notifies nobody', async () => {
    reader.questions.set(QUESTION, { ...reader.questions.get(QUESTION)!, authorId: OWNER });
    await new QaAnswerPostedNotifier(reader, kit.deliverer).handle(
      answered(OTHER, OWNER),
      FAKE_TRX,
      testHandlerContext(),
    );
    await new QaAnswerPostedNotifier(reader, kit.deliverer).handle(
      answered(OWNER, OWNER),
      FAKE_TRX,
      testHandlerContext(),
    );
    expect(kit.store.rows.map((r) => [r.userId, r.app])).toEqual([[OWNER, 'INSTRUCTOR']]);
  });

  it('QuestionResolved -> QA_RESOLVED to the accepted answer author, not on self-accept', async () => {
    const resolved = (actorId: string) =>
      envelope('QuestionResolved', 'engagement.question', {
        questionId: QUESTION,
        courseId: COURSE,
        answerId: ANSWER,
        actorId,
        resolvedAt: AT,
      });
    const handler = new QaQuestionResolvedNotifier(reader, kit.deliverer);
    await handler.handle(resolved(OTHER), FAKE_TRX, testHandlerContext());
    expect(kit.store.rows).toHaveLength(0);
    await handler.handle(resolved(STUDENT), FAKE_TRX, testHandlerContext());
    expect(kit.store.rows[0]).toMatchObject({
      userId: OTHER,
      kind: 'QA_RESOLVED',
      subjectId: QUESTION,
    });
  });
});

describe('review-notifier', () => {
  beforeEach(() => {
    reader.reviews.set(REVIEW, {
      id: REVIEW,
      courseId: COURSE,
      userId: STUDENT,
      rating: 2,
      body: 'Too\nfast',
      published: true,
      deleted: false,
    });
  });

  it('ReviewEdited notifies only when the rating changed', async () => {
    const edited = (rating: number, previousRating: number) =>
      envelope('ReviewEdited', 'engagement.course_review', {
        reviewId: REVIEW,
        courseId: COURSE,
        userId: STUDENT,
        rating,
        previousRating,
        editedAt: AT,
      });
    const handler = new ReviewEditedNotifier(reader, kit.deliverer);
    await handler.handle(edited(2, 2), FAKE_TRX, testHandlerContext());
    expect(kit.store.rows).toHaveLength(0);
    await handler.handle(edited(2, 5), FAKE_TRX, testHandlerContext());
    expect(kit.store.rows[0]).toMatchObject({
      userId: OWNER,
      kind: 'REVIEW_NEW',
      payload: { rating: 2, previousRating: 5, excerpt: 'Too fast' },
    });
  });

  it('ReviewReplyPosted -> REVIEW_REPLY to the reviewer, subject = the live reply', async () => {
    reader.replies.set(REPLY, {
      id: REPLY,
      reviewId: REVIEW,
      authorId: OWNER,
      body: 'Thanks!',
      visible: true,
    });
    await new ReviewReplyPostedNotifier(reader, kit.deliverer).handle(
      envelope('ReviewReplyPosted', 'engagement.course_review', {
        reviewId: REVIEW,
        courseId: COURSE,
        authorId: OWNER,
        postedAt: AT,
      }),
      FAKE_TRX,
      testHandlerContext(),
    );
    expect(kit.store.rows[0]).toMatchObject({
      userId: STUDENT,
      app: 'STUDENT',
      kind: 'REVIEW_REPLY',
      subjectId: REPLY,
      payload: { instructorName: 'Ina Structor', excerpt: 'Thanks!' },
    });
  });
});

describe('certificate-notifier', () => {
  const issued = envelope('CertificateIssued', 'learning.certificate', {
    certificateId: CERT,
    userId: STUDENT,
    courseId: COURSE,
    actorId: null,
    cause: 'COURSE_COMPLETED',
    issuedAt: AT,
  });

  it('ACTIVE -> CERTIFICATE_ISSUED with the verification link; REVOKED -> nothing', async () => {
    const cert: CertificateContext = {
      id: CERT,
      userId: STUDENT,
      courseId: COURSE,
      publicCode: CODE,
      courseTitle: 'Rust for beginners',
      status: 'REVOKED',
    };
    reader.certificates.set(CERT, cert);
    const handler = new CertificateIssuedNotifier(reader, kit.deliverer);
    await handler.handle(issued, FAKE_TRX, testHandlerContext());
    expect(kit.store.rows).toHaveLength(0);

    reader.certificates.set(CERT, { ...cert, status: 'ACTIVE' });
    await handler.handle(issued, FAKE_TRX, testHandlerContext());
    expect(kit.store.rows[0]).toMatchObject({
      kind: 'CERTIFICATE_ISSUED',
      subjectId: CERT,
      payload: { code: CODE },
    });
    expect(kit.mailer.sent[0]?.text).toContain(`http://localhost:3000/certificates/${CODE}`);
    expect(kit.mailer.sent[0]?.headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );
  });
});

describe('media-notifier', () => {
  it('MediaReady -> MEDIA_READY (no mail) and a media.changed hint after commit', async () => {
    const ctx = testHandlerContext();
    await new MediaReadyNotifier(reader, kit.deliverer, kit.realtime.asEmitter()).handle(
      envelope('MediaReady', 'media.asset', {
        assetId: ASSET,
        ownerId: OWNER,
        purpose: 'LECTURE_VIDEO',
        durationMs: 1000,
        width: 1280,
        height: 720,
        renditions: ['720p'],
        readyAt: AT,
      }),
      FAKE_TRX,
      ctx,
    );
    expect(kit.store.rows[0]).toMatchObject({
      kind: 'MEDIA_READY',
      payload: { filename: 'intro.mp4' },
    });
    expect(kit.mailer.sent).toHaveLength(0);
    await ctx.runAfterCommit();
    expect(kit.realtime.emitted.map((e) => e.event)).toEqual([
      'notification.created',
      'notification.unread',
      'media.changed',
    ]);
  });
});

describe('moderation-notifier', () => {
  const hidden = (actorId: string | null) =>
    envelope('QuestionHidden', 'engagement.question', {
      questionId: QUESTION,
      courseId: COURSE,
      actorId,
      hiddenAt: AT,
    });

  function handler(
    admins = new FakeAdmins([{ userId: ADMIN, email: 'a@x.test', displayName: 'Ad Min' }]),
  ) {
    return new QuestionHiddenNotifier(
      kit.store,
      reader,
      new HiddenContentNotices(reader, admins, kit.deliverer),
    );
  }

  it('AUTO hide: redacts the question and its answers, tells the author and every admin', async () => {
    await handler().handle(hidden(null), FAKE_TRX, testHandlerContext());
    expect(kit.store.redactions).toEqual([
      { subjectType: 'QUESTION', subjectIds: [QUESTION] },
      { subjectType: 'ANSWER', subjectIds: [ANSWER] },
    ]);
    expect(kit.store.rows.map((r) => [r.userId, r.app, r.kind, r.subjectId])).toEqual([
      [STUDENT, 'STUDENT', 'CONTENT_HIDDEN', null],
      [ADMIN, 'ADMIN', 'MODERATION_QUEUE', null],
    ]);
    expect(kit.store.rows[1]?.payload).toMatchObject({
      openReportCount: 3,
      subjectType: 'QUESTION',
    });
    expect(kit.mailer.sent.every((m) => m.headers === undefined)).toBe(true);
  });

  it('an admin hide tells the author only', async () => {
    await handler().handle(hidden(ADMIN), FAKE_TRX, testHandlerContext());
    expect(kit.store.kinds()).toEqual(['CONTENT_HIDDEN']);
  });

  it('AnnouncementDeleted redacts the announcement notifications', async () => {
    await new AnnouncementDeletedNotifier(kit.store).handle(
      envelope('AnnouncementDeleted', 'engagement.announcement', {
        announcementId: ANNOUNCEMENT,
        courseId: COURSE,
        authorId: OWNER,
        sendEmail: true,
        actorId: OWNER,
        deletedAt: AT,
      }),
      FAKE_TRX,
    );
    expect(kit.store.redactions).toEqual([
      { subjectType: 'ANNOUNCEMENT', subjectIds: [ANNOUNCEMENT] },
    ]);
  });
});

describe('room-revoker', () => {
  it('EnrollmentRevoked -> the student room leaves the course room, after commit only', async () => {
    const ctx = testHandlerContext();
    await new RoomRevokerHandler(kit.realtime.asEmitter()).handle(
      envelope('EnrollmentRevoked', 'enrollment.enrollment', {
        enrollmentId: ANNOUNCEMENT,
        userId: STUDENT,
        courseId: COURSE,
        reason: 'ADMIN',
        refundId: null,
        actorId: ADMIN,
        revokedAt: AT,
      }),
      FAKE_TRX,
      ctx,
    );
    expect(kit.realtime.left).toEqual([]);
    await ctx.runAfterCommit();
    expect(kit.realtime.left).toEqual([
      { fromRoom: `u:${STUDENT}:STUDENT`, rooms: [`c:${COURSE}`] },
    ]);
  });
});
