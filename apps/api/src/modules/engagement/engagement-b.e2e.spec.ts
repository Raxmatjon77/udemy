// Must stay the first import: AppModule validates process.env when it is imported.
import '../catalog/testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  AnnouncementLimitProblemSchema,
  AnnouncementPageSchema,
  AnnouncementSchema,
  AnswerSchema,
  type AuthResult,
  ErrorCode,
  InstructorAnnouncementPageSchema,
  InstructorQaPageSchema,
  MarkdownNotAllowedProblemSchema,
  ModerationQueuePageSchema,
  ModerationSubjectSchema,
  QuestionDetailSchema,
  QuestionPageSchema,
  QuestionSchema,
  ReportSchema,
} from '@udemy/contracts';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LECTURE_COMPLETIONS } from '../../shared/learning-progress';
import {
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { deleteCatalogTestData } from '../catalog/testing/catalog-it';
import {
  createTestCategory,
  deleteEnrollmentTestData,
  type PublishedTestCourse,
  publishTestCourse,
  setTestCoursePrice,
} from '../enrollment/testing/enrollment-it';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { engagementRateLimitKey } from './infrastructure/redis-engagement-rate-limiter';
import { deleteEngagementTestData, TestLectureCompletions } from './testing/engagement-it';

/*
 * P5-T13 routes (Phase 5 learning experience design §8 "Q&A", "Instructor", "Admin") through the
 * REAL AppModule: global guards in production order, zod validation, problem+json, Postgres,
 * Redis, MinIO.
 *
 * Covers: the authorization matrix (anonymous, the wrong BFF, the wrong role, a non-enrolled
 * learner, an instructor-app token on a course it does not own, a student on admin moderation),
 * the Q&A flow (ask, the owner's badged answer, votes, accept, sorts, outbox events keyed by
 * course on `engagement.question`), markdown refusals with structured issues, reports with
 * auto-hide (hidden = 404 for others, `hidden: true` for the author), the admin queue and
 * restore, the instructor inbox, and announcements (the 4 per 30 days quota with `retryAt`).
 */
const V1 = '/api/v1';

type Who =
  'anonymous' | 'outsider' | 'otherInstructor' | 'admin' | 'studentViaInstructorApp' | 'learner';

interface Fixtures {
  users: Record<
    'admin' | 'owner' | 'otherOwner' | 'alice' | 'bob' | 'carol' | 'outsider',
    SignedUpUser
  >;
  tokens: Record<
    'admin' | 'owner' | 'otherOwner' | 'alice' | 'bob' | 'carol' | 'outsider',
    AuthResult
  >;
  course: PublishedTestCourse;
  foreignCourse: PublishedTestCourse;
}

describe('engagement B endpoints (e2e: AppModule, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp({
    overrides: [{ provide: LECTURE_COMPLETIONS, useValue: new TestLectureCompletions() }],
  });
  const s3 = useIntegrationS3();
  const tag = randomUUID().slice(0, 8);
  const categoryIds: string[] = [];
  let fx: Fixtures | undefined;

  const available = (): boolean =>
    e2e.pg.available && e2e.redis.available && s3.unavailableReason === undefined;
  const get = <T>(token: abstract new (...args: never[]) => T): T =>
    e2e.app.get(token, { strict: false });
  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    e2e.skip(ctx);
    s3.skipIfUnavailable(ctx);
  };
  const allUserIds = (): string[] =>
    fx === undefined ? [] : Object.values(fx.users).map((u) => u.userId);
  const allCourseIds = (): string[] =>
    fx === undefined ? [] : [fx.course.courseId, fx.foreignCourse.courseId];

  const studentOf = (token: AuthResult) => e2e.as('student', token.accessToken);
  const instructorOf = (token: AuthResult) => e2e.as('instructor', token.accessToken);
  const adminOf = (token: AuthResult) => e2e.as('admin', token.accessToken);
  const qaPath = (suffix = '') => `${V1}/courses/${fixtures().course.courseId}${suffix}`;

  function call(who: Who, method: HttpMethod, path: string): request.Test {
    const { tokens } = fixtures();
    switch (who) {
      case 'anonymous':
        return e2e.http()[method](path).set(e2e.client('student'));
      case 'outsider':
        return studentOf(tokens.outsider).call(method, path);
      case 'learner':
        return studentOf(tokens.alice).call(method, path);
      case 'otherInstructor':
        return instructorOf(tokens.otherOwner).call(method, path);
      case 'admin':
        return adminOf(tokens.admin).call(method, path);
      case 'studentViaInstructorApp':
        return e2e.as('instructor', tokens.alice.accessToken).call(method, path);
    }
  }

  async function outboxTypes(courseId: string, aggregateType: string): Promise<string[]> {
    const rows = await e2e.pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', courseId)
      .where('aggregateType', '=', aggregateType)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    return rows.map((r) => r.type);
  }

  beforeAll(async () => {
    if (!available()) return;
    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `QA owner ${tag}` });
    const otherOwner = await e2e.signup({ displayName: `QA other owner ${tag}` });
    const alice = await e2e.signup({ displayName: `Alice ${tag}` });
    const bob = await e2e.signup();
    const carol = await e2e.signup();
    const outsider = await e2e.signup();
    await e2e.promoteToInstructor(owner.userId, admin.userId);
    await e2e.promoteToInstructor(otherOwner.userId, admin.userId);
    categoryIds.push(...(await createTestCategory(get, tag)));
    const publish = (ownerId: string, title: string) =>
      publishTestCourse(get, e2e.pg.db, s3.storage, {
        ownerId,
        adminId: admin.userId,
        categoryId: categoryIds[0] ?? '',
        title,
      });
    const course = await publish(owner.userId, `QA e2e ${tag}`);
    const foreignCourse = await publish(otherOwner.userId, `QA e2e foreign ${tag}`);
    await setTestCoursePrice(e2e.pg.db, course.courseId, '0.00', owner.userId);
    const tokens = {
      admin: await e2e.login('admin', admin.email),
      owner: await e2e.login('instructor', owner.email),
      otherOwner: await e2e.login('instructor', otherOwner.email),
      alice: await e2e.login('student', alice.email),
      bob: await e2e.login('student', bob.email),
      carol: await e2e.login('student', carol.email),
      outsider: await e2e.login('student', outsider.email),
    };
    for (const token of [tokens.alice, tokens.bob, tokens.carol]) {
      await studentOf(token)
        .post(`${V1}/me/free-enrollments`)
        .send({ courseId: course.courseId })
        .expect(201);
    }
    fx = {
      users: { admin, owner, otherOwner, alice, bob, carol, outsider },
      tokens,
      course,
      foreignCourse,
    };
  });

  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const ids = allUserIds();
    await deleteEngagementTestData(e2e.pg.db, { userIds: ids, courseIds: allCourseIds() });
    await deleteEnrollmentTestData(e2e.pg.db, { userIds: ids, courseIds: allCourseIds() });
    const rules = ['questionPost', 'answerPost', 'vote', 'report', 'announcementPost'] as const;
    await e2e.redis.redis.del(
      ...ids.flatMap((id) => rules.map((r) => engagementRateLimitKey(r, id))),
    );
    await deleteMediaTestData(e2e.pg.db, ids, { storage: s3.storage });
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: ids, categoryIds, deleteUsers: false });
  });

  /* ------------------------------------------------------------------ authorization matrix */

  interface Route {
    readonly method: HttpMethod;
    readonly path: () => string;
    readonly body?: () => object;
  }

  const routes: Record<string, Route> = {
    'GET questions': { method: 'get', path: () => qaPath('/questions') },
    'POST questions': {
      method: 'post',
      path: () => qaPath('/questions'),
      body: () => ({ title: 'Denied question', bodyMd: 'x' }),
    },
    'GET question': { method: 'get', path: () => qaPath(`/questions/${randomUUID()}`) },
    'PUT question vote': { method: 'put', path: () => qaPath(`/questions/${randomUUID()}/vote`) },
    'GET instructor/qa': { method: 'get', path: () => `${V1}/instructor/qa` },
    'GET announcements (owner)': { method: 'get', path: () => qaPath('/announcements') },
    'POST announcements': {
      method: 'post',
      path: () => qaPath('/announcements'),
      body: () => ({ title: 'Denied announcement', bodyMd: 'x' }),
    },
    'GET my announcements': {
      method: 'get',
      path: () => `${V1}/me/courses/${fixtures().course.courseId}/announcements`,
    },
    'POST question report': {
      method: 'post',
      path: () => `${V1}/engagement/questions/${randomUUID()}/reports`,
      body: () => ({ reason: 'SPAM' }),
    },
    'GET admin queue': { method: 'get', path: () => `${V1}/admin/moderation/reports` },
    'POST admin hide': {
      method: 'post',
      path: () => `${V1}/admin/moderation/questions/${randomUUID()}/hide`,
      body: () => ({ reason: 'A long enough reason' }),
    },
  };

  const DENIED: readonly (readonly [
    route: string,
    who: Who,
    status: 401 | 403 | 404,
    code?: string,
  ])[] = [
    ...Object.keys(routes).map((route) => [route, 'anonymous', 401] as const),
    // a token is bound to its BFF
    ...Object.keys(routes).map((route) => [route, 'studentViaInstructorApp', 401] as const),
    // Q&A: learner or owner (an instructor-app token passes only on owned courses)
    ['GET questions', 'outsider', 403, ErrorCode.EnrollmentRequired],
    ['POST questions', 'outsider', 403, ErrorCode.EnrollmentRequired],
    ['GET questions', 'otherInstructor', 403, ErrorCode.EnrollmentRequired],
    ['GET questions', 'admin', 403],
    ['GET my announcements', 'outsider', 403, ErrorCode.EnrollmentRequired],
    ['GET my announcements', 'otherInstructor', 403],
    // course:engage:own
    ['GET instructor/qa', 'learner', 403],
    ['GET instructor/qa', 'admin', 403],
    ['GET announcements (owner)', 'otherInstructor', 404],
    ['POST announcements', 'otherInstructor', 404],
    ['POST announcements', 'learner', 403],
    // content:report: student and instructor apps only
    ['POST question report', 'admin', 403],
    // content:moderate:any
    ['GET admin queue', 'learner', 403],
    ['GET admin queue', 'otherInstructor', 403],
    ['POST admin hide', 'learner', 403],
  ];

  it.for(DENIED)('%s as %s -> %i', async ([name, who, status, code], ctx) => {
    skip(ctx);
    const route = routes[name];
    if (route === undefined) throw new Error(`unknown route ${name}`);
    const req = call(who, route.method, route.path());
    const res = route.body === undefined ? await req : await req.send(route.body());
    expectProblem(res, status, code);
  });

  it('nothing was written by the denied calls', async (ctx) => {
    skip(ctx);
    const questions = await e2e.pg.db
      .selectFrom('engagement.questions')
      .select('id')
      .where('courseId', '=', fixtures().course.courseId)
      .execute();
    const announcements = await e2e.pg.db
      .selectFrom('engagement.announcements')
      .select('id')
      .where('courseId', '=', fixtures().course.courseId)
      .execute();
    expect({ questions, announcements }).toEqual({ questions: [], announcements: [] });
  });

  /* ------------------------------------------------------------------ Q&A flow */

  it('ask (201) -> the owner answers with the badge -> votes -> accept; sorts; outbox keyed by course', async (ctx) => {
    skip(ctx);
    const { tokens, users, course } = fixtures();
    const alice = studentOf(tokens.alice);
    const owner = instructorOf(tokens.owner);

    const q = QuestionSchema.parse(
      (
        await alice
          .post(qaPath('/questions'))
          .send({ title: '  How do closures capture variables?  ', bodyMd: 'See `x`.' })
          .expect(201)
      ).body,
    );
    expect(q).toMatchObject({
      title: 'How do closures capture variables?',
      mine: true,
      lectureId: null,
    });
    expectProblem(
      await alice
        .post(qaPath('/questions'))
        .send({ title: 'Lecture question', bodyMd: 'x', lectureId: randomUUID() }),
      404,
      ErrorCode.LectureNotFound,
    );
    const markdown = await alice
      .post(qaPath('/questions'))
      .send({ title: 'Sneaky question', bodyMd: '<img src=x onerror=alert(1)>' });
    expectProblem(markdown, 422, ErrorCode.MarkdownNotAllowed);
    expect(MarkdownNotAllowedProblemSchema.parse(markdown.body).issues[0]?.path).toBe('bodyMd');

    const answer = AnswerSchema.parse(
      (
        await owner
          .post(qaPath(`/questions/${q.id}/answers`))
          .send({ bodyMd: 'They capture the binding.' })
          .expect(201)
      ).body,
    );
    expect(answer).toMatchObject({ byInstructor: true, author: { id: users.owner.userId } });

    await studentOf(tokens.bob)
      .put(qaPath(`/questions/${q.id}/vote`))
      .expect(204);
    await studentOf(tokens.bob)
      .put(qaPath(`/questions/${q.id}/vote`))
      .expect(204);
    expectProblem(
      await alice.put(qaPath(`/questions/${q.id}/vote`)),
      422,
      ErrorCode.CannotVoteOwnContent,
    );
    await alice.put(qaPath(`/answers/${answer.id}/vote`)).expect(204);

    expectProblem(
      await studentOf(tokens.bob)
        .put(qaPath(`/questions/${q.id}/accepted-answer`))
        .send({ answerId: answer.id }),
      403,
      ErrorCode.NotContentAuthor,
    );
    const resolved = QuestionSchema.parse(
      (
        await alice
          .put(qaPath(`/questions/${q.id}/accepted-answer`))
          .send({ answerId: answer.id })
          .expect(200)
      ).body,
    );
    expect(resolved).toMatchObject({ resolved: true, acceptedAnswerId: answer.id, upvoteCount: 1 });

    const detail = QuestionDetailSchema.parse(
      (await alice.get(qaPath(`/questions/${q.id}`)).expect(200)).body,
    );
    expect(detail.answers.items).toEqual([
      expect.objectContaining({ id: answer.id, accepted: true, voted: true, upvoteCount: 1 }),
    ]);
    const top = QuestionPageSchema.parse(
      (await alice.get(qaPath('/questions?sort=top')).expect(200)).body,
    );
    expect(top.items[0]?.id).toBe(q.id);
    const search = QuestionPageSchema.parse(
      (await owner.get(qaPath('/questions?q=closures')).expect(200)).body,
    );
    expect(search.items.map((x) => x.id)).toEqual([q.id]);
    expectProblem(await alice.get(qaPath('/questions?q=ab')), 400, ErrorCode.ValidationFailed);

    // IDOR: the question through another course's path
    expectProblem(
      await instructorOf(tokens.otherOwner).get(
        `${V1}/courses/${fixtures().foreignCourse.courseId}/questions/${q.id}`,
      ),
      404,
      ErrorCode.QuestionNotFound,
    );

    expect(await outboxTypes(course.courseId, 'engagement.question')).toEqual([
      'QuestionPosted.v1',
      'AnswerPosted.v1',
      'QuestionResolved.v1',
    ]);
  });

  it('instructor inbox: unanswered first; status filters; a foreign courseId is 404', async (ctx) => {
    skip(ctx);
    const { tokens, foreignCourse } = fixtures();
    const owner = instructorOf(tokens.owner);
    const open = QuestionSchema.parse(
      (
        await studentOf(tokens.bob)
          .post(qaPath('/questions'))
          .send({ title: 'Nobody answered me yet', bodyMd: 'Help' })
          .expect(201)
      ).body,
    );
    const unanswered = InstructorQaPageSchema.parse(
      (await owner.get(`${V1}/instructor/qa`).expect(200)).body,
    );
    expect(unanswered.items.map((i) => i.question.id)).toContain(open.id);
    expect(unanswered.items.every((i) => i.question.answerCount === 0)).toBe(true);
    const all = InstructorQaPageSchema.parse(
      (await owner.get(`${V1}/instructor/qa?status=all`).expect(200)).body,
    );
    expect(all.items.length).toBeGreaterThan(unanswered.items.length);
    expectProblem(
      await owner.get(`${V1}/instructor/qa?courseId=${foreignCourse.courseId}`),
      404,
      ErrorCode.CourseNotFound,
    );
  });

  /* ------------------------------------------------------------------ reports + moderation */

  it('three reporters auto-hide a question; author sees it hidden; admin queue and restore', async (ctx) => {
    skip(ctx);
    const { tokens, users, course } = fixtures();
    const q = QuestionSchema.parse(
      (
        await studentOf(tokens.alice)
          .post(qaPath('/questions'))
          .send({ title: 'Buy cheap watches here', bodyMd: 'spam' })
          .expect(201)
      ).body,
    );
    const reportPath = `${V1}/engagement/questions/${q.id}/reports`;
    expectProblem(
      await studentOf(tokens.alice).post(reportPath).send({ reason: 'SPAM' }),
      422,
      ErrorCode.CannotReportOwnContent,
    );
    expectProblem(
      await studentOf(tokens.outsider).post(reportPath).send({ reason: 'SPAM' }),
      404,
      ErrorCode.QuestionNotFound,
    );
    await studentOf(tokens.bob).post(reportPath).send({ reason: 'SPAM' }).expect(201);
    await instructorOf(tokens.owner).post(reportPath).send({ reason: 'SPAM' }).expect(201);
    const third = ReportSchema.parse(
      (await studentOf(tokens.carol).post(reportPath).send({ reason: 'SPAM' }).expect(201)).body,
    );
    expect(third.status).toBe('ACTIONED');
    expect(await outboxTypes(course.courseId, 'engagement.question')).toContain(
      'QuestionHidden.v1',
    );

    expectProblem(
      await studentOf(tokens.bob).get(qaPath(`/questions/${q.id}`)),
      404,
      ErrorCode.QuestionNotFound,
    );
    const own = QuestionDetailSchema.parse(
      (
        await studentOf(tokens.alice)
          .get(qaPath(`/questions/${q.id}`))
          .expect(200)
      ).body,
    );
    expect(own.hidden).toBe(true);

    const admin = adminOf(tokens.admin);
    const queue = ModerationQueuePageSchema.parse(
      (await admin.get(`${V1}/admin/moderation/reports?status=ACTIONED&type=QUESTION`).expect(200))
        .body,
    );
    const item = queue.items.find((i) => i.subjectId === q.id);
    expect(item).toMatchObject({
      moderationStatus: 'HIDDEN',
      openReportCount: 0,
      preview: { title: 'Buy cheap watches here', bodyIsMarkdown: true },
    });
    expect(item?.actions.map((a) => [a.action, a.actor])).toEqual([['HIDE', null]]);

    expectProblem(
      await admin
        .post(`${V1}/admin/moderation/questions/${q.id}/restore`)
        .send({ reason: 'short' }),
      400,
      ErrorCode.ValidationFailed,
    );
    const restored = ModerationSubjectSchema.parse(
      (
        await admin
          .post(`${V1}/admin/moderation/questions/${q.id}/restore`)
          .send({ reason: 'Reviewed: not spam after all' })
          .expect(200)
      ).body,
    );
    expect(restored.moderationStatus).toBe('VISIBLE');
    expect(restored.actions.map((a) => [a.action, a.actor?.id ?? null])).toEqual([
      ['HIDE', null],
      ['RESTORE', users.admin.userId],
    ]);
    expectProblem(
      await admin
        .post(`${V1}/admin/moderation/questions/${q.id}/restore`)
        .send({ reason: 'Reviewed: not spam after all' }),
      409,
      ErrorCode.InvalidStateTransition,
    );
    expect(await outboxTypes(course.courseId, 'engagement.question')).toContain(
      'QuestionRestored.v1',
    );
  });

  /* ------------------------------------------------------------------ announcements */

  it('announcements: 4 per 30 days, the 5th is 422 with retryAt; learners read; delete 204 then 404', async (ctx) => {
    skip(ctx);
    const { tokens, course } = fixtures();
    const owner = instructorOf(tokens.owner);
    const posted = [];
    for (let i = 0; i < 4; i += 1) {
      posted.push(
        AnnouncementSchema.parse(
          (
            await owner
              .post(qaPath('/announcements'))
              .send({ title: `Weekly update ${i}`, bodyMd: 'News', sendEmail: i === 0 })
              .expect(201)
          ).body,
        ),
      );
    }
    const refused = await owner
      .post(qaPath('/announcements'))
      .send({ title: 'One too many', bodyMd: 'News' });
    expectProblem(refused, 422, ErrorCode.AnnouncementLimitExceeded);
    const problem = AnnouncementLimitProblemSchema.parse(refused.body);
    expect(Date.parse(problem.retryAt)).toBe(
      Date.parse(posted[0]?.createdAt ?? '') + 30 * 86_400_000,
    );

    const page = InstructorAnnouncementPageSchema.parse(
      (await owner.get(qaPath('/announcements')).expect(200)).body,
    );
    expect(page.quota).toMatchObject({ limit: 4, used: 4, nextAvailableAt: problem.retryAt });
    const learner = AnnouncementPageSchema.parse(
      (
        await studentOf(tokens.alice)
          .get(`${V1}/me/courses/${course.courseId}/announcements?limit=2`)
          .expect(200)
      ).body,
    );
    expect(learner.items).toHaveLength(2);
    expect(learner.nextCursor).not.toBeNull();

    const first = posted[0]?.id ?? '';
    await owner.delete(qaPath(`/announcements/${first}`)).expect(204);
    expectProblem(
      await owner.delete(qaPath(`/announcements/${first}`)),
      404,
      ErrorCode.AnnouncementNotFound,
    );
    // deleting does not refund the quota
    expectProblem(
      await owner.post(qaPath('/announcements')).send({ title: 'Still too many', bodyMd: 'x' }),
      422,
      ErrorCode.AnnouncementLimitExceeded,
    );
    expect(await outboxTypes(course.courseId, 'engagement.announcement')).toEqual([
      'AnnouncementPosted.v1',
      'AnnouncementPosted.v1',
      'AnnouncementPosted.v1',
      'AnnouncementPosted.v1',
      'AnnouncementDeleted.v1',
    ]);
  });
});
