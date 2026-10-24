import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as main from '../index.js';
import {
  createCommerceHandlers,
  createCommerceMockStore,
  createLearningHandlers,
  createLearningMockStore,
  FIXTURE_IDS,
  fixtureId,
  LEARNING_FIXTURE_IDS as L,
  type LearningMockSeed,
  makeAnnouncement,
  makeCertificate,
  makeCertificateVerification,
  makeCompletionState,
  makeCourseRating,
  makeInstructorReview,
  makeModerationQueueItem,
  makeMyCourseReview,
  makeNote,
  makeNotification,
  makeNotificationPreferences,
  makePlayerBootstrap,
  makeProgressAck,
  makePublicReview,
  makeQuestionDetail,
  makeQuizAttempt,
  makeQuizAttemptDetail,
  makeQuizAuthoring,
  makeQuizResult,
  makeRealtimeTicket,
  makeReport,
  makeRevisionQuiz,
  makeUnreadCount,
  makeWishlistItem,
} from './index.mjs';

describe('Phase 5 fixtures', () => {
  it('are exported from the testing subpath only', () => {
    expect(Object.keys(main)).not.toContain('createLearningHandlers');
    expect(Object.keys(main)).not.toContain('makePlayerBootstrap');
  });

  it('build every view, parsed by its schema', () => {
    expect(makePlayerBootstrap().progress).toEqual({ completed: 1, total: 4, pct: 25 });
    expect(makeProgressAck().coursePct).toBe(25);
    expect(makeCompletionState({ completed: false })).toMatchObject({ cause: null });
    expect(makeNote().positionSeconds).toBe(42);
    expect(JSON.stringify(makeQuizAttempt())).not.toMatch(/isCorrect|explanation/);
    expect(makeQuizResult()).toMatchObject({ scorePct: 67, passed: true, revealed: true });
    expect(
      makeQuizResult({ passed: false }).questions.every((q) => q.correctOptions === null),
    ).toBe(true);
    expect(makeQuizAttemptDetail().result?.attemptId).toBe(L.attempt);
    expect(makeQuizAttemptDetail({ status: 'IN_PROGRESS' }).result).toBeNull();
    expect(makeCertificate({ status: 'REVOKED' }).revokedAt).not.toBeNull();
    expect(makeCertificateVerification({ status: 'REVOKED' }).pdfAvailable).toBe(false);
    expect(makeQuizAuthoring().questions).toHaveLength(3);
    expect(makeRevisionQuiz().questions[0]!.options[1]!.isCorrect).toBe(true);
    expect(makeCourseRating()).toMatchObject({ count: 40, average: '4.6' });
    expect(makePublicReview().rating).toBe(5);
    expect(makeMyCourseReview().canReview).toBe(true);
    expect(makeInstructorReview().state).toBe('PUBLISHED');
    expect(makeQuestionDetail().answers.items).toHaveLength(1);
    expect(makeAnnouncement().sendEmail).toBe(true);
    expect(makeWishlistItem().available).toBe(true);
    expect(makeReport().status).toBe('OPEN');
    expect(makeModerationQueueItem().reports).toHaveLength(1);
    expect(makeNotification().kind).toBe('QA_NEW_ANSWER');
    expect(makeUnreadCount(250)).toEqual({ count: 100, capped: true });
    expect(makeNotificationPreferences().items).toHaveLength(12);
    expect(makeRealtimeTicket().ticket).toHaveLength(43);
    expect(() => makeNote({ id: 'nope' })).toThrow();
  });
});

describe('createLearningHandlers (MSW)', () => {
  const API = 'http://api.test/api/v1';
  const server = setupServer();
  let now = Date.parse('2026-10-23T10:00:00.000Z');
  let store = createLearningMockStore();

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  /** A fresh commerce + learning mock over one store, with a controllable clock. */
  function reset(seed: Omit<LearningMockSeed, 'commerce'> = {}) {
    now = Date.parse('2026-10-23T10:00:00.000Z');
    const commerce = createCommerceHandlers({
      baseUrl: API,
      store: createCommerceMockStore({ now: () => new Date(now), ...seed.commerceSeed }),
    });
    const learning = createLearningHandlers({
      baseUrl: API,
      store: createLearningMockStore({ ...seed, commerce: commerce.store }),
    });
    store = learning.store;
    server.use(...commerce.handlers, ...learning.handlers);
    return store;
  }

  /** Switch the signed-in user and app (one viewer makes every request). */
  function as(userId: string, app: 'student' | 'instructor' | 'admin' = 'student') {
    store.commerce.viewerId = userId;
    store.viewerApp = app;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json; headers: Headers }> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      json: text === '' ? null : (JSON.parse(text) as Json),
      headers: response.headers,
    };
  }

  const course = FIXTURE_IDS.course;
  const lecturePath = (lectureId: string) => `/me/courses/${course}/lectures/${lectureId}`;

  it('enforces the learner access rule: 404, then 403 enrollment_required, owner preview', async () => {
    reset();
    expect((await call('GET', `/me/courses/${fixtureId(9)}/learn`)).status).toBe(404);
    const denied = await call('GET', `/me/courses/${course}/learn`);
    expect(denied).toMatchObject({ status: 403, json: { code: 'enrollment_required' } });

    as(FIXTURE_IDS.instructor);
    const preview = await call('GET', `/me/courses/${course}/learn`);
    expect(preview.json).toMatchObject({ mode: 'PREVIEW', resume: null, certificate: null });
    expect(
      (
        await call('PUT', `${lecturePath(L.lectureVideo)}/progress`, {
          positionSeconds: 1,
          ranges: [],
        })
      ).json.code,
    ).toBe('enrollment_required');

    as(FIXTURE_IDS.student, 'instructor');
    expect((await call('GET', `/me/courses/${course}/learn`)).json.code).toBe('forbidden');

    as(FIXTURE_IDS.student);
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    const boot = await call('GET', `/me/courses/${course}/learn`);
    expect(boot.json).toMatchObject({
      mode: 'LEARNER',
      progress: { completed: 0, total: 4, pct: 0 },
      resume: { lectureId: L.lectureVideo, positionSeconds: null },
    });
    // a lecture of another course through this course's path
    expect((await call('POST', `${lecturePath(L.course2Video)}/quiz-attempts`)).json.code).toBe(
      'lecture_not_found',
    );
  });

  it('measures video coverage with the plausibility budget and completes at 90% (D3, D4)', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    const beat = (positionSeconds: number, ranges: { from: number; to: number }[]) =>
      call('PUT', `${lecturePath(L.lectureVideo)}/progress`, { positionSeconds, ranges });

    // first heartbeat: 60 s budget, so a claimed 0–300 "watch" counts nothing
    expect((await beat(300, [{ from: 0, to: 300 }])).json).toMatchObject({
      lectureCompleted: false,
      coursePct: 0,
    });
    expect(
      (await call('GET', `/me/courses/${course}/learn`)).json.sections[0].lectures[0],
    ).toMatchObject({
      positionSeconds: 300,
      coveragePct: 0,
    });
    // real time passes: 15 s → budget 47.5 s per heartbeat; 0–225 s covers 45 of 60 buckets
    for (let from = 0; from < 225; from += 45) {
      now += 15_000;
      await beat(from + 45, [{ from, to: from + 45 }]);
    }
    expect(
      (await call('GET', `/me/courses/${course}/learn`)).json.sections[0].lectures[0],
    ).toMatchObject({
      completed: false,
      coveragePct: 75,
    });
    // a forged range beyond the budget is dropped
    now += 15_000;
    expect((await beat(300, [{ from: 225, to: 300 }])).json.lectureCompleted).toBe(false);
    now += 15_000;
    // 225–270 reaches 54 of 60 buckets (90%): the lecture completes server-side
    const done = await beat(270, [{ from: 225, to: 270 }]);
    expect(done.json).toMatchObject({
      lectureCompleted: true,
      courseCompleted: false,
      coursePct: 25,
    });
    // manual completion of a video is refused
    expect(
      (await call('POST', `${lecturePath(L.lectureVideo)}/completion`, { cause: 'MANUAL' })).json
        .code,
    ).toBe('completion_not_allowed');
    expect(
      (
        await call('PUT', `${lecturePath(L.lectureArticle)}/progress`, {
          positionSeconds: 0,
          ranges: [],
        })
      ).json.code,
    ).toBe('lecture_type_mismatch');
  });

  it('runs article → resource → quiz → course completion → certificate → verification', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    store.seedCompletion(FIXTURE_IDS.student, course, [L.lectureVideo]);

    const article = await call('POST', `${lecturePath(L.lectureArticle)}/completion`, {
      cause: 'ARTICLE_READ',
    });
    expect(article.json).toMatchObject({
      completed: true,
      cause: 'ARTICLE_READ',
      progress: { pct: 50 },
    });
    expect(
      (
        await call('POST', `${lecturePath(L.lectureResource)}/completion`, {
          cause: 'ARTICLE_READ',
        })
      ).json.code,
    ).toBe('completion_not_allowed');
    await call('POST', `${lecturePath(L.lectureResource)}/completion`, {
      cause: 'RESOURCE_OPENED',
    });
    const undone = await call('DELETE', `${lecturePath(L.lectureResource)}/completion`);
    expect(undone.json).toMatchObject({ completed: false, progress: { pct: 50 } });
    await call('POST', `${lecturePath(L.lectureResource)}/completion`, { cause: 'MANUAL' });

    // quiz: start (no keys), resume, wrong submit (no reveal), retry, pass (reveal)
    const started = await call('POST', `${lecturePath(L.lectureQuiz)}/quiz-attempts`);
    expect(started.status).toBe(201);
    expect(JSON.stringify(started.json)).not.toMatch(/isCorrect|"correct|explanation/);
    expect((await call('POST', `${lecturePath(L.lectureQuiz)}/quiz-attempts`)).status).toBe(200);
    const attemptId = started.json.id as string;
    expect(
      (
        await call('POST', `/me/quiz-attempts/${attemptId}/submit`, {
          answers: [{ questionId: L.quizQuestion1, optionPositions: [0, 1] }],
        })
      ).json.code,
    ).toBe('quiz_answers_invalid');
    const failed = await call('POST', `/me/quiz-attempts/${attemptId}/submit`, {
      answers: [{ questionId: L.quizQuestion1, optionPositions: [1] }],
    });
    expect(failed.json).toMatchObject({ scorePct: 33, passed: false, revealed: false });
    expect(failed.json.questions[0]).toMatchObject({
      yourAnswerCorrect: true,
      correctOptions: null,
    });
    // a repeat returns the stored result
    expect(
      (await call('POST', `/me/quiz-attempts/${attemptId}/submit`, { answers: [] })).json.scorePct,
    ).toBe(33);

    const second = await call('POST', `${lecturePath(L.lectureQuiz)}/quiz-attempts`);
    expect(second.status).toBe(201);
    const passed = await call('POST', `/me/quiz-attempts/${second.json.id}/submit`, {
      answers: [
        { questionId: L.quizQuestion1, optionPositions: [1] },
        { questionId: L.quizQuestion2, optionPositions: [2, 0] },
        { questionId: L.quizQuestion3, optionPositions: [1] },
      ],
    });
    expect(passed.json).toMatchObject({
      scorePct: 100,
      passed: true,
      revealed: true,
      progress: { lectureCompleted: true, courseCompleted: true, coursePct: 100 },
    });
    expect(passed.json.questions[1].correctOptions).toEqual([0, 2]);
    const attempts = await call('GET', `${lecturePath(L.lectureQuiz)}/quiz-attempts`);
    expect(attempts.json.items.map((a: Json) => a.passed)).toEqual([true, false]);
    expect((await call('GET', `/me/quiz-attempts/${attemptId}`)).json.result.passed).toBe(false);

    // the issuer worker ran: certificate + notification + realtime push
    const boot = (await call('GET', `/me/courses/${course}/learn`)).json;
    expect(boot).toMatchObject({ completedAt: expect.any(String), newContent: false });
    expect(boot.certificate).toMatchObject({ status: 'ACTIVE' });
    const mine = (await call('GET', '/me/certificates')).json.items;
    expect(mine).toHaveLength(1);
    expect((await call('GET', `/me/certificates/${mine[0].id}/pdf`)).json.url).toContain(
      `certificates/${mine[0].id}/v1.pdf`,
    );
    const inbox = (await call('GET', '/me/notifications')).json.items;
    expect(inbox[0]).toMatchObject({ kind: 'CERTIFICATE_ISSUED', app: 'STUDENT' });
    expect(store.realtimeEvents.map((e) => e.event)).toContain('notification.created');

    const verify = await call('GET', `/certificates/${boot.certificate.code}`);
    expect(verify.headers.get('cache-control')).toBe('private, max-age=60');
    expect(verify.json).toMatchObject({
      status: 'ACTIVE',
      recipientName: 'Jane Student',
      pdfAvailable: true,
    });
    expect((await call('GET', '/certificates/NOTACODE')).status).toBe(400);

    // my learning shows the progress through COURSE_PROGRESS
    const cards = (await call('GET', '/me/enrollments')).json.items;
    expect(cards[0]).toMatchObject({ courseId: course, progress: 100 });

    // revoke → certificate revoked, learner routes 403, notes still editable; regrant reinstates
    const note = (
      await call('POST', `/me/courses/${course}/notes`, {
        lectureId: L.lectureVideo,
        positionSeconds: 12,
        bodyMd: 'Key idea',
      })
    ).json;
    store.commerce.revokeEnrollmentOf(FIXTURE_IDS.student, course, 'REFUND');
    expect((await call('GET', `/certificates/${boot.certificate.code}`)).json.status).toBe(
      'REVOKED',
    );
    expect((await call('GET', `/certificates/${boot.certificate.code}/pdf`)).status).toBe(404);
    expect((await call('GET', `/me/courses/${course}/learn`)).status).toBe(403);
    expect((await call('PATCH', `/me/notes/${note.id}`, { bodyMd: 'Edited' })).json.bodyMd).toBe(
      'Edited',
    );
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    expect((await call('GET', `/certificates/${boot.certificate.code}`)).json.status).toBe(
      'ACTIVE',
    );
  });

  it('pages notes with an opaque cursor and enforces the note rules', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    for (let i = 0; i < 3; i++) {
      now += 1000;
      await call('POST', `/me/courses/${course}/notes`, {
        lectureId: L.lectureArticle,
        bodyMd: `n${i}`,
      });
    }
    const first = (await call('GET', `/me/courses/${course}/notes?limit=2`)).json;
    expect(first.items.map((n: Json) => n.bodyMd)).toEqual(['n2', 'n1']);
    const second = (
      await call('GET', `/me/courses/${course}/notes?limit=2&cursor=${first.nextCursor}`)
    ).json;
    expect(second).toMatchObject({ nextCursor: null, items: [{ bodyMd: 'n0' }] });
    expect((await call('GET', `/me/courses/${course}/notes?cursor=bogus`)).status).toBe(422);
    expect(
      (
        await call('POST', `/me/courses/${course}/notes`, {
          lectureId: L.lectureArticle,
          positionSeconds: 3,
          bodyMd: 'x',
        })
      ).status,
    ).toBe(422);
    as(FIXTURE_IDS.instructor);
    expect((await call('DELETE', `/me/notes/${first.items[0].id}`)).status).toBe(404);
  });

  it('rate-limits like the api: 429 rate_limited with Retry-After', async () => {
    reset({ rateLimits: { heartbeat: { limit: 1, windowMs: 60_000 } } });
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    const beat = () =>
      call('PUT', `${lecturePath(L.lectureVideo)}/progress`, { positionSeconds: 1, ranges: [] });
    expect((await beat()).status).toBe(200);
    const limited = await beat();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.json).toMatchObject({ code: 'rate_limited' });
    now += 60_000;
    expect((await beat()).status).toBe(200);
  });

  it('reviews: eligibility, upsert, public list, ratings, instructor reply, revoke suspension', async () => {
    reset();
    const reviewPath = `/me/courses/${course}/review`;
    expect((await call('GET', reviewPath)).json).toMatchObject({
      canReview: false,
      blockReason: 'enrollment_required',
    });
    expect((await call('PUT', reviewPath, { rating: 5 })).json.code).toBe('enrollment_required');
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    expect((await call('PUT', reviewPath, { rating: 5 })).status).toBe(422);
    store.seedCompletion(FIXTURE_IDS.student, course, [L.lectureArticle]);
    const created = await call('PUT', reviewPath, { rating: 5, body: 'Great course' });
    expect(created.status).toBe(201);
    expect((await call('PUT', reviewPath, { rating: 4, body: 'Great course' })).status).toBe(200);
    store.seedReview(FIXTURE_IDS.admin, course, 2, 'Too fast');

    const ratings = await call(
      'GET',
      `/engagement/ratings?courseIds=${course},${FIXTURE_IDS.course2}`,
    );
    expect(ratings.headers.get('cache-control')).toBe('public, max-age=60');
    expect(ratings.json.items).toEqual([
      {
        courseId: course,
        average: '3.0',
        count: 2,
        histogram: { '1': 0, '2': 1, '3': 0, '4': 1, '5': 0 },
      },
      {
        courseId: FIXTURE_IDS.course2,
        average: null,
        count: 0,
        histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      },
    ]);
    expect(
      (await call('GET', `/engagement/courses/${course}/reviews?rating=4`)).json.items,
    ).toHaveLength(1);

    as(FIXTURE_IDS.instructor);
    expect((await call('PUT', reviewPath, { rating: 5 })).json.code).toBe(
      'cannot_review_own_course',
    );
    as(FIXTURE_IDS.instructor, 'instructor');
    const list = (await call('GET', `/courses/${course}/reviews`)).json.items;
    const replied = await call('PUT', `/courses/${course}/reviews/${created.json.id}/reply`, {
      body: 'Thanks!',
    });
    expect(replied.json).toMatchObject({ body: 'Thanks!', hidden: false });
    expect(list).toHaveLength(2);
    expect((await call('GET', `/courses/${FIXTURE_IDS.course2}/reviews`)).status).toBe(200);
    as(FIXTURE_IDS.student, 'instructor');
    expect((await call('GET', `/courses/${course}/reviews`)).status).toBe(404);
    // the instructor was notified of the review; the student of the reply
    as(FIXTURE_IDS.instructor, 'instructor');
    expect((await call('GET', '/me/notifications')).json.items.map((n: Json) => n.kind)).toContain(
      'REVIEW_NEW',
    );
    as(FIXTURE_IDS.student);
    expect((await call('GET', '/me/notifications')).json.items[0].kind).toBe('REVIEW_REPLY');

    store.commerce.revokeEnrollmentOf(FIXTURE_IDS.student, course);
    expect((await call('GET', `/engagement/ratings?courseIds=${course}`)).json.items[0].count).toBe(
      1,
    );
    expect((await call('GET', reviewPath)).json.review.state).toBe('SUSPENDED');
  });

  it('Q&A: ask, answer, vote, accept, sorts, instructor app scope and the inbox', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    const asked = await call('POST', `/courses/${course}/questions`, {
      lectureId: L.lectureVideo,
      title: 'Why const?',
      bodyMd: 'Explain please',
    });
    expect(asked.status).toBe(201);
    const questionId = asked.json.id as string;
    expect(store.realtimeEvents.at(-1)).toMatchObject({
      room: `c:${course}`,
      event: 'qa.changed',
      payload: { questionId, lectureId: L.lectureVideo },
    });
    await call('POST', `/courses/${course}/questions`, { title: 'Second one', bodyMd: 'x' });
    expect((await call('PUT', `/courses/${course}/questions/${questionId}/vote`)).json.code).toBe(
      'cannot_vote_own_content',
    );

    as(FIXTURE_IDS.admin);
    expect((await call('GET', `/courses/${course}/questions`)).json.code).toBe(
      'enrollment_required',
    );

    as(FIXTURE_IDS.instructor, 'instructor');
    const inbox = (await call('GET', '/instructor/qa')).json.items;
    expect(inbox).toHaveLength(2);
    expect(inbox[0]).toMatchObject({ course: { id: course } });
    const answer = await call('POST', `/courses/${course}/questions/${questionId}/answers`, {
      bodyMd: 'Binding, not value.',
    });
    expect(answer.json).toMatchObject({ byInstructor: true, mine: true });
    expect((await call('PUT', `/courses/${course}/questions/${questionId}/vote`)).status).toBe(204);
    expect((await call('GET', '/instructor/qa?status=unanswered')).json.items).toHaveLength(1);
    expect((await call('GET', `/courses/${FIXTURE_IDS.course2}/questions`)).status).toBe(200);
    as(FIXTURE_IDS.student, 'instructor');
    expect((await call('GET', `/courses/${course}/questions`)).json.code).toBe(
      'enrollment_required',
    );

    as(FIXTURE_IDS.student);
    const top = (await call('GET', `/courses/${course}/questions?sort=top`)).json.items;
    expect(top[0]).toMatchObject({ id: questionId, upvoteCount: 1, answerCount: 1 });
    expect(
      (await call('GET', `/courses/${course}/questions?sort=unanswered`)).json.items,
    ).toHaveLength(1);
    expect((await call('GET', `/courses/${course}/questions?q=const`)).json.items).toHaveLength(1);
    const notified = (await call('GET', '/me/notifications')).json.items[0];
    expect(notified).toMatchObject({ kind: 'QA_NEW_ANSWER', payload: { byInstructor: true } });
    const accepted = await call(
      'PUT',
      `/courses/${course}/questions/${questionId}/accepted-answer`,
      {
        answerId: answer.json.id,
      },
    );
    expect(accepted.json).toMatchObject({ resolved: true, acceptedAnswerId: answer.json.id });
    const detail = (await call('GET', `/courses/${course}/questions/${questionId}`)).json;
    expect(detail.answers.items[0]).toMatchObject({ accepted: true });
    expect(
      (await call('PATCH', `/courses/${course}/answers/${answer.json.id}`, { bodyMd: 'Nope' })).json
        .code,
    ).toBe('not_content_author');
    expect(
      (
        await call('PUT', `/courses/${course}/questions/${questionId}/accepted-answer`, {
          answerId: fixtureId(77),
        })
      ).json.code,
    ).toBe('answer_not_found');
  });

  it('reports auto-hide at the threshold; admins restore with a reason', async () => {
    reset();
    for (const userId of [
      FIXTURE_IDS.student,
      FIXTURE_IDS.admin,
      fixtureId(0x5702),
      fixtureId(0x5703),
    ]) {
      store.commerce.users.set(
        userId,
        store.commerce.users.get(userId) ?? {
          id: userId,
          displayName: `User ${userId.slice(-2)}`,
          email: `${userId.slice(-4)}@example.com`,
        },
      );
      store.commerce.seedEnrollment(userId, course);
    }
    const questionId = (
      await call('POST', `/courses/${course}/questions`, {
        title: 'Spam spam spam',
        bodyMd: 'Buy now',
      })
    ).json.id as string;
    expect(
      (await call('POST', `/engagement/questions/${questionId}/reports`, { reason: 'SPAM' })).json
        .code,
    ).toBe('cannot_report_own_content');
    as(FIXTURE_IDS.admin);
    const first = await call('POST', `/engagement/questions/${questionId}/reports`, {
      reason: 'SPAM',
    });
    expect(first.status).toBe(201);
    expect(
      (await call('POST', `/engagement/questions/${questionId}/reports`, { reason: 'SPAM' }))
        .status,
    ).toBe(200);
    store.seedReport('QUESTION', questionId, fixtureId(0x5702));
    store.seedReport('QUESTION', questionId, fixtureId(0x5703));
    // hidden: 404 for others, visible to the author with a flag
    expect((await call('GET', `/courses/${course}/questions/${questionId}`)).status).toBe(404);
    as(FIXTURE_IDS.student);
    expect((await call('GET', `/courses/${course}/questions/${questionId}`)).json.hidden).toBe(
      true,
    );
    expect((await call('GET', '/me/notifications')).json.items[0].kind).toBe('CONTENT_HIDDEN');

    as(FIXTURE_IDS.admin, 'admin');
    expect((await call('GET', '/me/notifications')).json.items[0]).toMatchObject({
      kind: 'MODERATION_QUEUE',
      app: 'ADMIN',
    });
    const queue = (await call('GET', '/admin/moderation/reports?type=QUESTION')).json.items;
    expect(queue[0]).toMatchObject({
      subjectId: questionId,
      moderationStatus: 'HIDDEN',
      openReportCount: 3,
      actions: [{ action: 'HIDE', actor: null }],
    });
    expect(
      (await call('POST', `/admin/moderation/questions/${questionId}/restore`, { reason: 'short' }))
        .status,
    ).toBe(400);
    const restored = await call('POST', `/admin/moderation/questions/${questionId}/restore`, {
      reason: 'Reviewed: not spam',
    });
    expect(restored.json).toMatchObject({ moderationStatus: 'VISIBLE', openReportCount: 0 });
    expect(
      (
        await call('POST', `/admin/moderation/questions/${questionId}/restore`, {
          reason: 'Reviewed: not spam',
        })
      ).json.code,
    ).toBe('invalid_state_transition');
    expect(
      (await call('POST', `/admin/moderation/nope/${questionId}/hide`, { reason: 'x'.repeat(10) }))
        .status,
    ).toBe(400);
    as(FIXTURE_IDS.student);
    expect((await call('GET', '/admin/moderation/reports')).json.code).toBe('forbidden');
  });

  it('announcements: quota with retryAt, fan-out to enrollees, delete redacts', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    as(FIXTURE_IDS.instructor, 'instructor');
    const post = (title: string) =>
      call('POST', `/courses/${course}/announcements`, {
        title,
        bodyMd: 'Hello',
        sendEmail: false,
      });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      now += 1000;
      ids.push((await post(`Update number ${i}`)).json.id as string);
    }
    const limited = await post('One too many');
    expect(limited.json).toMatchObject({
      code: 'announcement_limit_exceeded',
      retryAt: expect.any(String),
    });
    const page = (await call('GET', `/courses/${course}/announcements`)).json;
    expect(page.quota).toMatchObject({ limit: 4, used: 4, nextAvailableAt: limited.json.retryAt });
    expect((await call('DELETE', `/courses/${course}/announcements/${ids[0]}`)).status).toBe(204);
    // deleting does not refund the quota
    expect((await post('Still limited')).status).toBe(422);
    as(FIXTURE_IDS.student);
    expect((await call('GET', `/me/courses/${course}/announcements`)).json.items).toHaveLength(3);
    const inbox = (await call('GET', '/me/notifications')).json.items;
    expect(inbox).toHaveLength(4);
    expect(inbox.find((n: Json) => n.subjectId === ids[0]).payload).toMatchObject({
      title: null,
      redacted: true,
    });
  });

  it('wishlist rules (D19)', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    expect((await call('PUT', `/me/wishlist/${course}`)).json.code).toBe('course_not_wishlistable');
    expect((await call('PUT', `/me/wishlist/${fixtureId(5)}`)).status).toBe(404);
    expect((await call('PUT', `/me/wishlist/${FIXTURE_IDS.course2}`)).status).toBe(204);
    expect((await call('PUT', `/me/wishlist/${FIXTURE_IDS.course2}`)).status).toBe(204);
    expect((await call('GET', '/me/wishlist')).json.items).toMatchObject([
      { courseId: FIXTURE_IDS.course2, available: true },
    ]);
    expect(
      (await call('GET', `/me/wishlist/states?courseIds=${FIXTURE_IDS.course2},${course}`)).json
        .items,
    ).toEqual([
      { courseId: FIXTURE_IDS.course2, wishlisted: true },
      { courseId: course, wishlisted: false },
    ]);
    expect((await call('DELETE', `/me/wishlist/${FIXTURE_IDS.course2}`)).status).toBe(204);
    expect((await call('GET', '/me/wishlist')).json.items).toHaveLength(0);
  });

  it('notifications: unread count, mark read, preferences, unsubscribe, realtime tickets', async () => {
    reset();
    for (let i = 0; i < 3; i++) {
      now += 1000;
      store.notify(
        FIXTURE_IDS.student,
        'STUDENT',
        'MEDIA_READY',
        {
          assetId: fixtureId(i + 1),
          purpose: 'LECTURE_VIDEO',
          filename: null,
        },
        null,
      );
    }
    store.notify(
      FIXTURE_IDS.student,
      'INSTRUCTOR',
      'MEDIA_FAILED',
      {
        assetId: fixtureId(9),
        purpose: 'LECTURE_VIDEO',
        filename: 'a.mp4',
        failureCode: 'probe_failed',
      },
      null,
    );
    expect((await call('GET', '/me/notifications/unread-count')).json).toEqual({
      count: 3,
      capped: false,
    });
    const items = (await call('GET', '/me/notifications?limit=2')).json.items;
    // read-all marks the given row and every older one
    expect((await call('POST', '/me/notifications/read-all', { upToId: items[1].id })).status).toBe(
      204,
    );
    expect((await call('GET', '/me/notifications?unreadOnly=true')).json.items).toHaveLength(1);
    expect((await call('GET', '/me/notifications/unread-count')).json.count).toBe(1);
    expect((await call('POST', `/me/notifications/${fixtureId(4)}/read`)).status).toBe(404);
    expect(store.realtimeEvents.at(-1)).toMatchObject({
      event: 'notification.unread',
      payload: { count: 1 },
    });
    expect((await call('POST', `/me/notifications/${items[0].id}/read`)).status).toBe(204);
    expect((await call('GET', '/me/notifications/unread-count')).json.count).toBe(0);

    const prefs = (await call('GET', '/me/notification-preferences')).json.items;
    expect(
      prefs.find((p: Json) => p.category === 'MODERATION' && p.channel === 'EMAIL').locked,
    ).toBe(true);
    expect(
      (
        await call('PUT', '/me/notification-preferences', {
          items: [{ category: 'MODERATION', channel: 'EMAIL', enabled: false }],
        })
      ).json.code,
    ).toBe('preference_locked');
    const updated = await call('PUT', '/me/notification-preferences', {
      items: [{ category: 'QA', channel: 'IN_APP', enabled: false }],
    });
    expect(
      updated.json.items.find((p: Json) => p.category === 'QA' && p.channel === 'IN_APP'),
    ).toMatchObject({
      enabled: false,
      isDefault: false,
    });

    const token = store.unsubscribeToken(FIXTURE_IDS.student, 'ANNOUNCEMENTS');
    expect((await call('POST', '/notifications/unsubscribe', { token })).status).toBe(204);
    expect(
      (await call('POST', '/notifications/unsubscribe', { token: `${token}x` })).json.code,
    ).toBe('invalid_unsubscribe_token');
    expect(
      (await call('GET', '/me/notification-preferences')).json.items.find(
        (p: Json) => p.category === 'ANNOUNCEMENTS' && p.channel === 'EMAIL',
      ).enabled,
    ).toBe(false);

    const ticket = await call('POST', '/realtime/tickets');
    expect(ticket.status).toBe(201);
    expect(ticket.json).toMatchObject({
      url: 'http://127.0.0.1:3001',
      expiresAt: '2026-10-23T10:00:33.000Z',
    });
    store.realtimeAvailable = false;
    expect((await call('POST', '/realtime/tickets')).json.code).toBe('realtime_unavailable');
  });

  it('quiz authoring on the working copy, publish, and attempts against the new revision', async () => {
    reset();
    as(FIXTURE_IDS.instructor, 'instructor');
    const base = `/courses/${course}/lectures/${L.lectureQuiz}/quiz`;
    const quiz = (await call('GET', base)).json;
    expect(quiz).toMatchObject({ passPct: 70, version: 1 });
    expect(quiz.questions[0].options[1].isCorrect).toBe(true);
    expect(
      (await call('GET', `/courses/${course}/lectures/${L.lectureVideo}/quiz`)).json.code,
    ).toBe('lecture_type_mismatch');
    expect((await call('PUT', base, { passPct: 50 })).json).toMatchObject({
      passPct: 50,
      version: 2,
    });
    const added = (
      await call('POST', `${base}/questions`, { kind: 'SINGLE_CHOICE', promptMd: 'New?' })
    ).json;
    expect(added).toMatchObject({ position: 3, complete: false, options: [] });
    const withOptions = await call('PUT', `${base}/questions/${added.id}/options`, {
      options: [
        { text: 'Yes', isCorrect: true },
        { text: 'No', isCorrect: false },
      ],
    });
    expect(withOptions.json.complete).toBe(true);
    expect((await call('PUT', `${base}/order`, { questionIds: [added.id] })).json.code).toBe(
      'order_mismatch',
    );
    const ids = [added.id, L.quizQuestion1, L.quizQuestion2, L.quizQuestion3];
    expect((await call('PUT', `${base}/order`, { questionIds: ids })).json.questions[0].id).toBe(
      added.id,
    );
    expect((await call('DELETE', `${base}/questions/${L.quizQuestion3}`)).status).toBe(204);

    // a learner's open attempt is abandoned once a new revision is live
    as(FIXTURE_IDS.student);
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    const open = (await call('POST', `${lecturePath(L.lectureQuiz)}/quiz-attempts`)).json;
    const revisionId = store.publishWorkingQuiz(course, L.lectureQuiz);
    const fresh = await call('POST', `${lecturePath(L.lectureQuiz)}/quiz-attempts`);
    expect(fresh.status).toBe(201);
    expect(fresh.json).toMatchObject({ revisionId, passPct: 50, questionCount: 3 });
    expect((await call('GET', `/me/quiz-attempts/${open.id}`)).json.status).toBe('ABANDONED');
    expect(
      (await call('POST', `/me/quiz-attempts/${open.id}/submit`, { answers: [] })).json.code,
    ).toBe('attempt_not_in_progress');

    as(FIXTURE_IDS.admin, 'admin');
    const revision = (
      await call('GET', `/admin/course-revisions/${revisionId}/lectures/${L.lectureQuiz}/quiz`)
    ).json;
    expect(revision.questions[0]).toMatchObject({
      id: added.id,
      options: [{ isCorrect: true }, { isCorrect: false }],
    });
  });

  it('admin certificates: revoke and reinstate with a reason', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    store.seedCompletion(FIXTURE_IDS.student, course);
    as(FIXTURE_IDS.admin, 'admin');
    const [entry] = (await call('GET', `/admin/users/${FIXTURE_IDS.student}/certificates`)).json
      .items;
    expect(entry.transitions).toMatchObject([{ action: 'ISSUE', cause: 'COURSE_COMPLETED' }]);
    const id = entry.certificate.id as string;
    expect(
      (await call('POST', `/admin/certificates/${id}/reinstate`, { reason: 'Not revoked yet' }))
        .status,
    ).toBe(409);
    const revoked = await call('POST', `/admin/certificates/${id}/revoke`, {
      reason: 'Plagiarised work',
    });
    expect(revoked.json).toMatchObject({
      certificate: { status: 'REVOKED' },
      transitions: [{}, { action: 'REVOKE', cause: 'ADMIN', actor: { id: FIXTURE_IDS.admin } }],
    });
    expect((await call('GET', `/admin/users/${fixtureId(1)}/certificates`)).json.code).toBe(
      'user_not_found',
    );
  });

  it('admin certificates: an admin revocation sticks across an enrollment revoke + regrant', async () => {
    reset();
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    store.seedCompletion(FIXTURE_IDS.student, course);
    as(FIXTURE_IDS.admin, 'admin');
    const [entry] = (await call('GET', `/admin/users/${FIXTURE_IDS.student}/certificates`)).json
      .items;
    const id = entry.certificate.id as string;
    await call('POST', `/admin/certificates/${id}/revoke`, { reason: 'Plagiarised work' });
    store.commerce.revokeEnrollmentOf(FIXTURE_IDS.student, course, 'REFUND');
    store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
    const [after] = (await call('GET', `/admin/users/${FIXTURE_IDS.student}/certificates`)).json
      .items;
    expect(after.certificate.status).toBe('REVOKED');
    expect(after.transitions.map((t: { action: string }) => t.action)).toEqual(['ISSUE', 'REVOKE']);
  });
});
