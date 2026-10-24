// Must stay the first import: AppModule validates process.env when it is imported.
import '../catalog/testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  type AuthResult,
  ErrorCode,
  InstructorReviewPageSchema,
  MyCourseReviewSchema,
  MyReviewSchema,
  PUBLIC_ENGAGEMENT_CACHE_CONTROL,
  PublicReviewPageSchema,
  RatingsResponseSchema,
  ReportSchema,
  ReviewReplySchema,
  WishlistPageSchema,
  WishlistStatesResponseSchema,
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
 * P5-T12 routes (Phase 5 learning experience design §8) through the REAL AppModule: global
 * guards in production order, zod validation, problem+json, Postgres, Redis, MinIO. Learning
 * (P5-T10) is not there yet, so `LECTURE_COMPLETIONS` is overridden with a controllable
 * counter; everything else is production wiring.
 *
 * Covers: the authorization matrix (anonymous, the wrong BFF, the wrong role), the review
 * gate (owner 403, not enrolled 403, no completed lecture 422), the review upsert and its
 * outbox events keyed by course, the public list, the instructor list and reply (IDOR: another
 * instructor's course and a review of another course are 404), reports with auto-hide (3), the
 * wishlist rules, and the IDOR of the own-review routes.
 */
const V1 = '/api/v1';

type Who = 'anonymous' | 'student' | 'instructor' | 'admin' | 'studentViaInstructorApp';

interface Fixtures {
  users: {
    admin: SignedUpUser;
    owner: SignedUpUser;
    otherOwner: SignedUpUser;
    student: SignedUpUser;
    fresh: SignedUpUser;
    outsider: SignedUpUser;
    r1: SignedUpUser;
    r2: SignedUpUser;
    r3: SignedUpUser;
  };
  tokens: {
    admin: AuthResult;
    owner: AuthResult;
    ownerAsStudent: AuthResult;
    otherOwner: AuthResult;
    student: AuthResult;
    fresh: AuthResult;
    outsider: AuthResult;
    r1: AuthResult;
    r2: AuthResult;
    r3: AuthResult;
  };
  course: PublishedTestCourse;
  wishCourse: PublishedTestCourse;
  foreignCourse: PublishedTestCourse;
}

describe('engagement A endpoints (e2e: AppModule, Postgres, Redis, MinIO)', () => {
  const completions = new TestLectureCompletions();
  const e2e: E2eHarness = useE2eApp({
    overrides: [{ provide: LECTURE_COMPLETIONS, useValue: completions }],
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
    fx === undefined ? [] : [fx.course.courseId, fx.wishCourse.courseId, fx.foreignCourse.courseId];

  const studentOf = (token: AuthResult) => e2e.as('student', token.accessToken);
  const instructorOf = (token: AuthResult) => e2e.as('instructor', token.accessToken);

  function call(who: Who, method: HttpMethod, path: string): request.Test {
    const { tokens } = fixtures();
    switch (who) {
      case 'anonymous':
        return e2e.http()[method](path).set(e2e.client('student'));
      case 'student':
        return studentOf(tokens.outsider).call(method, path);
      case 'instructor':
        return instructorOf(tokens.otherOwner).call(method, path);
      case 'admin':
        return e2e.as('admin', tokens.admin.accessToken).call(method, path);
      case 'studentViaInstructorApp':
        return e2e.as('instructor', tokens.student.accessToken).call(method, path);
    }
  }

  async function outboxTypes(courseId: string): Promise<string[]> {
    const rows = await e2e.pg.db
      .selectFrom('outbox.events')
      .select(['type', 'aggregateType'])
      .where('aggregateId', '=', courseId)
      .where('aggregateType', 'like', 'engagement.%')
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    expect(rows.every((r) => r.aggregateType === 'engagement.course_review')).toBe(true);
    return rows.map((r) => r.type);
  }

  beforeAll(async () => {
    if (!available()) return;
    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    const otherOwner = await e2e.signup({ displayName: `Other owner ${tag}` });
    const student = await e2e.signup();
    const fresh = await e2e.signup();
    const outsider = await e2e.signup();
    const r1 = await e2e.signup();
    const r2 = await e2e.signup();
    const r3 = await e2e.signup();
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
    const course = await publish(owner.userId, `Engagement e2e ${tag}`);
    const wishCourse = await publish(owner.userId, `Engagement e2e wish ${tag}`);
    const foreignCourse = await publish(otherOwner.userId, `Engagement e2e foreign ${tag}`);
    await setTestCoursePrice(e2e.pg.db, course.courseId, '0.00', owner.userId);
    await setTestCoursePrice(e2e.pg.db, foreignCourse.courseId, '0.00', otherOwner.userId);
    const tokens = {
      admin: await e2e.login('admin', admin.email),
      owner: await e2e.login('instructor', owner.email),
      ownerAsStudent: await e2e.login('student', owner.email),
      otherOwner: await e2e.login('instructor', otherOwner.email),
      student: await e2e.login('student', student.email),
      fresh: await e2e.login('student', fresh.email),
      outsider: await e2e.login('student', outsider.email),
      r1: await e2e.login('student', r1.email),
      r2: await e2e.login('student', r2.email),
      r3: await e2e.login('student', r3.email),
    };
    // Enroll (free) everyone who reviews; `outsider` stays unenrolled in `course`.
    for (const token of [tokens.student, tokens.fresh]) {
      await studentOf(token)
        .post(`${V1}/me/free-enrollments`)
        .send({ courseId: course.courseId })
        .expect(201);
      await studentOf(token)
        .post(`${V1}/me/free-enrollments`)
        .send({ courseId: foreignCourse.courseId })
        .expect(201);
    }
    completions.set(student.userId, course.courseId, 1);
    completions.set(student.userId, foreignCourse.courseId, 2);
    fx = {
      users: { admin, owner, otherOwner, student, fresh, outsider, r1, r2, r3 },
      tokens,
      course,
      wishCourse,
      foreignCourse,
    };
  });

  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const ids = allUserIds();
    await deleteEngagementTestData(e2e.pg.db, { userIds: ids, courseIds: allCourseIds() });
    await deleteEnrollmentTestData(e2e.pg.db, { userIds: ids, courseIds: allCourseIds() });
    const rules = ['reviewWrite', 'reviewReply', 'wishlistWrite', 'report'] as const;
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
    'GET /me/courses/:courseId/review': {
      method: 'get',
      path: () => `${V1}/me/courses/${fixtures().course.courseId}/review`,
    },
    'PUT /me/courses/:courseId/review': {
      method: 'put',
      path: () => `${V1}/me/courses/${fixtures().course.courseId}/review`,
      body: () => ({ rating: 5 }),
    },
    'DELETE /me/courses/:courseId/review': {
      method: 'delete',
      path: () => `${V1}/me/courses/${fixtures().course.courseId}/review`,
    },
    'GET /me/wishlist': { method: 'get', path: () => `${V1}/me/wishlist` },
    'GET /me/wishlist/states': {
      method: 'get',
      path: () => `${V1}/me/wishlist/states?courseIds=${fixtures().course.courseId}`,
    },
    'PUT /me/wishlist/:courseId': {
      method: 'put',
      path: () => `${V1}/me/wishlist/${fixtures().wishCourse.courseId}`,
    },
    'DELETE /me/wishlist/:courseId': {
      method: 'delete',
      path: () => `${V1}/me/wishlist/${fixtures().wishCourse.courseId}`,
    },
    'GET /courses/:courseId/reviews': {
      method: 'get',
      path: () => `${V1}/courses/${fixtures().course.courseId}/reviews`,
    },
    'PUT /courses/:courseId/reviews/:reviewId/reply': {
      method: 'put',
      path: () => `${V1}/courses/${fixtures().course.courseId}/reviews/${randomUUID()}/reply`,
      body: () => ({ body: 'Thanks' }),
    },
    'DELETE /courses/:courseId/reviews/:reviewId/reply': {
      method: 'delete',
      path: () => `${V1}/courses/${fixtures().course.courseId}/reviews/${randomUUID()}/reply`,
    },
    'POST /engagement/reviews/:id/reports': {
      method: 'post',
      path: () => `${V1}/engagement/reviews/${randomUUID()}/reports`,
      body: () => ({ reason: 'SPAM' }),
    },
    'POST /engagement/review-replies/:id/reports': {
      method: 'post',
      path: () => `${V1}/engagement/review-replies/${randomUUID()}/reports`,
      body: () => ({ reason: 'SPAM' }),
    },
  };

  const STUDENT_ONLY = [
    'GET /me/courses/:courseId/review',
    'PUT /me/courses/:courseId/review',
    'DELETE /me/courses/:courseId/review',
    'GET /me/wishlist',
    'GET /me/wishlist/states',
    'PUT /me/wishlist/:courseId',
    'DELETE /me/wishlist/:courseId',
  ];
  const OWNER_ONLY = [
    'GET /courses/:courseId/reviews',
    'PUT /courses/:courseId/reviews/:reviewId/reply',
    'DELETE /courses/:courseId/reviews/:reviewId/reply',
  ];
  const REPORTS = [
    'POST /engagement/reviews/:id/reports',
    'POST /engagement/review-replies/:id/reports',
  ];

  /** Denied combinations only: allowed ones change state and are covered by the flows below. */
  const DENIED: readonly (readonly [route: string, who: Who, status: 401 | 403 | 404])[] = [
    ...Object.keys(routes).flatMap((route) => [
      [route, 'anonymous', 401] as const,
      [route, 'studentViaInstructorApp', 401] as const,
    ]),
    // STUDENT permissions exist in the student app only (D6)
    ...STUDENT_ONLY.flatMap((route) => [
      [route, 'instructor', 403] as const,
      [route, 'admin', 403] as const,
    ]),
    // course:engage:own: students and admins lack it; another instructor's course is 404
    ...OWNER_ONLY.flatMap((route) => [
      [route, 'student', 403] as const,
      [route, 'admin', 403] as const,
      [route, 'instructor', 404] as const,
    ]),
    // content:report: student and instructor apps only
    ...REPORTS.map((route) => [route, 'admin', 403] as const),
  ];

  it.for(DENIED)('%s as %s -> %i', async ([name, who, status], ctx) => {
    skip(ctx);
    const route = routes[name];
    if (route === undefined) throw new Error(`unknown route ${name}`);
    const req = call(who, route.method, route.path());
    const res = route.body === undefined ? await req : await req.send(route.body());
    expectProblem(res, status);
  });

  it('nothing was written by the denied calls', async (ctx) => {
    skip(ctx);
    const reviews = await e2e.pg.db
      .selectFrom('engagement.reviews')
      .select('id')
      .where('courseId', '=', fixtures().course.courseId)
      .execute();
    const wishes = await e2e.pg.db
      .selectFrom('engagement.wishlistItems')
      .select('userId')
      .where('courseId', '=', fixtures().wishCourse.courseId)
      .execute();
    expect({ reviews, wishes }).toEqual({ reviews: [], wishes: [] });
  });

  /* ------------------------------------------------------------------ public reads */

  it('public: ratings batch (count 0 without reviews), cache header, 400 over 48 ids', async (ctx) => {
    skip(ctx);
    const { course } = fixtures();
    const unknown = randomUUID();
    const res = await e2e
      .http()
      .get(`${V1}/engagement/ratings?courseIds=${course.courseId},${unknown}`)
      .set(e2e.client('student'))
      .expect(200);
    expect(res.headers['cache-control']).toBe(PUBLIC_ENGAGEMENT_CACHE_CONTROL);
    expect(RatingsResponseSchema.parse(res.body).items.map((i) => [i.courseId, i.count])).toEqual([
      [course.courseId, 0],
      [unknown, 0],
    ]);
    const tooMany = Array.from({ length: 49 }, () => randomUUID()).join(',');
    expectProblem(
      await e2e
        .http()
        .get(`${V1}/engagement/ratings?courseIds=${tooMany}`)
        .set(e2e.client('student')),
      400,
      ErrorCode.ValidationFailed,
    );
    expectProblem(
      await e2e
        .http()
        .get(`${V1}/engagement/courses/${randomUUID()}/reviews`)
        .set(e2e.client('student')),
      404,
      ErrorCode.CourseNotFound,
    );
  });

  /* ------------------------------------------------------------------ reviews */

  it('review gate: owner 403, not enrolled 403, no completed lecture 422; GET explains it', async (ctx) => {
    skip(ctx);
    const { course, tokens } = fixtures();
    const path = `${V1}/me/courses/${course.courseId}/review`;

    expectProblem(
      await studentOf(tokens.ownerAsStudent).put(path).send({ rating: 5 }),
      403,
      ErrorCode.CannotReviewOwnCourse,
    );
    expectProblem(
      await studentOf(tokens.outsider).put(path).send({ rating: 5 }),
      403,
      ErrorCode.EnrollmentRequired,
    );
    expectProblem(
      await studentOf(tokens.fresh).put(path).send({ rating: 5 }),
      422,
      ErrorCode.ReviewNotEligible,
    );
    const state = MyCourseReviewSchema.parse(
      (await studentOf(tokens.fresh).get(path).expect(200)).body,
    );
    expect(state).toEqual({
      courseId: course.courseId,
      review: null,
      canReview: false,
      blockReason: ErrorCode.ReviewNotEligible,
    });
    expectProblem(await studentOf(tokens.student).put(path).send({ rating: 6 }), 400);
    expectProblem(
      await studentOf(tokens.student).get(`${V1}/me/courses/${randomUUID()}/review`),
      404,
      ErrorCode.CourseNotFound,
    );
  });

  it('review: 201 posted -> 200 unchanged -> 200 edited; outbox ReviewPosted/ReviewEdited keyed by course; public list', async (ctx) => {
    skip(ctx);
    const { course, tokens, users } = fixtures();
    const student = studentOf(tokens.student);
    const path = `${V1}/me/courses/${course.courseId}/review`;

    const posted = MyReviewSchema.parse(
      (await student.put(path).send({ rating: 4, body: '  Clear and practical.  ' }).expect(201))
        .body,
    );
    expect(posted).toMatchObject({ rating: 4, body: 'Clear and practical.', state: 'PUBLISHED' });
    const same = await student
      .put(path)
      .send({ rating: 4, body: 'Clear and practical.' })
      .expect(200);
    expect(same.body).toEqual(posted);
    const edited = MyReviewSchema.parse(
      (await student.put(path).send({ rating: 5, body: 'Clear and practical.' }).expect(200)).body,
    );
    expect(edited).toMatchObject({ id: posted.id, rating: 5 });
    expect(edited.editedAt).not.toBeNull();

    expect(await outboxTypes(course.courseId)).toEqual(['ReviewPosted.v1', 'ReviewEdited.v1']);

    const page = PublicReviewPageSchema.parse(
      (
        await e2e
          .http()
          .get(`${V1}/engagement/courses/${course.courseId}/reviews?rating=5`)
          .set(e2e.client('student'))
          .expect(200)
      ).body,
    );
    expect(page.items.map((r) => r.id)).toEqual([posted.id]);
    expect(page.items[0]?.author?.id).toBe(users.student.userId);
  });

  it("instructor: lists the reviews, replies (200), the reply is public; another course's review is 404", async (ctx) => {
    skip(ctx);
    const { course, foreignCourse, tokens, users } = fixtures();
    const owner = instructorOf(tokens.owner);
    const list = InstructorReviewPageSchema.parse(
      (await owner.get(`${V1}/courses/${course.courseId}/reviews`).expect(200)).body,
    );
    const review = list.items.find((r) => r.author?.id === users.student.userId);
    if (review === undefined) throw new Error('the student review is missing');
    expect(review.state).toBe('PUBLISHED');

    const reply = ReviewReplySchema.parse(
      (
        await owner
          .put(`${V1}/courses/${course.courseId}/reviews/${review.id}/reply`)
          .send({ body: 'Thank you!' })
          .expect(200)
      ).body,
    );
    expect(reply).toMatchObject({
      reviewId: review.id,
      hidden: false,
      author: { id: users.owner.userId },
    });

    // IDOR: a review of another course through my course path
    const foreign = await studentOf(tokens.student)
      .put(`${V1}/me/courses/${foreignCourse.courseId}/review`)
      .send({ rating: 3 })
      .expect(201);
    expectProblem(
      await owner
        .put(`${V1}/courses/${course.courseId}/reviews/${String(foreign.body.id)}/reply`)
        .send({ body: 'Not mine' }),
      404,
      ErrorCode.ReviewNotFound,
    );

    const page = PublicReviewPageSchema.parse(
      (
        await e2e
          .http()
          .get(`${V1}/engagement/courses/${course.courseId}/reviews`)
          .set(e2e.client('student'))
          .expect(200)
      ).body,
    );
    expect(page.items.find((r) => r.id === review.id)?.reply).toMatchObject({ body: 'Thank you!' });
    expect(await outboxTypes(course.courseId)).toContain('ReviewReplyPosted.v1');
  });

  /* ------------------------------------------------------------------ reports */

  it('reports: own 422, 201 then 200; three reporters auto-hide (ReviewHidden); the review leaves the public list', async (ctx) => {
    skip(ctx);
    const { course, tokens } = fixtures();
    const mine = MyReviewSchema.parse(
      (
        await studentOf(tokens.student)
          .get(`${V1}/me/courses/${course.courseId}/review`)
          .expect(200)
      ).body.review,
    );
    const path = `${V1}/engagement/reviews/${mine.id}/reports`;

    expectProblem(
      await studentOf(tokens.student).post(path).send({ reason: 'SPAM' }),
      422,
      ErrorCode.CannotReportOwnContent,
    );
    const first = ReportSchema.parse(
      (await studentOf(tokens.r1).post(path).send({ reason: 'SPAM', comment: 'Ad' }).expect(201))
        .body,
    );
    expect(first).toMatchObject({ subjectType: 'REVIEW', subjectId: mine.id, status: 'OPEN' });
    const repeat = await studentOf(tokens.r1).post(path).send({ reason: 'ABUSE' }).expect(200);
    expect(repeat.body).toEqual(first);
    // an instructor-app token may report too (content:report in both apps)
    await instructorOf(tokens.otherOwner).post(path).send({ reason: 'OFF_TOPIC' }).expect(201);
    const third = ReportSchema.parse(
      (await studentOf(tokens.r2).post(path).send({ reason: 'SPAM' }).expect(201)).body,
    );
    expect(third.status).toBe('ACTIONED');
    expect(await outboxTypes(course.courseId)).toContain('ReviewHidden.v1');

    // hidden: gone from the public list, visible to its author with the HIDDEN state, 404 to report
    const page = PublicReviewPageSchema.parse(
      (
        await e2e
          .http()
          .get(`${V1}/engagement/courses/${course.courseId}/reviews`)
          .set(e2e.client('student'))
          .expect(200)
      ).body,
    );
    expect(page.items.map((r) => r.id)).not.toContain(mine.id);
    const own = MyCourseReviewSchema.parse(
      (
        await studentOf(tokens.student)
          .get(`${V1}/me/courses/${course.courseId}/review`)
          .expect(200)
      ).body,
    );
    expect(own.review?.state).toBe('HIDDEN');
    expectProblem(
      await studentOf(tokens.r3).post(path).send({ reason: 'SPAM' }),
      404,
      ErrorCode.ReviewNotFound,
    );
    const actions = await e2e.pg.db
      .selectFrom('engagement.moderationActions')
      .select(['action', 'actorId'])
      .where('subjectId', '=', mine.id)
      .execute();
    expect(actions).toEqual([{ action: 'HIDE', actorId: null }]);
  });

  it('review reply reports are addressed by the review id; the owner cannot report their reply', async (ctx) => {
    skip(ctx);
    const { foreignCourse, tokens } = fixtures();
    const foreignReview = MyReviewSchema.parse(
      (
        await studentOf(tokens.student)
          .get(`${V1}/me/courses/${foreignCourse.courseId}/review`)
          .expect(200)
      ).body.review,
    );
    const replyPath = `${V1}/engagement/review-replies/${foreignReview.id}/reports`;
    expectProblem(
      await studentOf(tokens.r1).post(replyPath).send({ reason: 'SPAM' }),
      404,
      ErrorCode.ReplyNotFound,
    );
    await instructorOf(tokens.otherOwner)
      .put(`${V1}/courses/${foreignCourse.courseId}/reviews/${foreignReview.id}/reply`)
      .send({ body: 'Thanks for the feedback' })
      .expect(200);
    expectProblem(
      await instructorOf(tokens.otherOwner).post(replyPath).send({ reason: 'SPAM' }),
      422,
      ErrorCode.CannotReportOwnContent,
    );
    const report = ReportSchema.parse(
      (await studentOf(tokens.r1).post(replyPath).send({ reason: 'HARASSMENT' }).expect(201)).body,
    );
    expect(report).toMatchObject({ subjectType: 'REVIEW_REPLY', subjectId: foreignReview.id });

    // delete the reply (204) -> 404 reply_not_found
    const replyRoute = `${V1}/courses/${foreignCourse.courseId}/reviews/${foreignReview.id}/reply`;
    await instructorOf(tokens.otherOwner).delete(replyRoute).expect(204);
    expectProblem(
      await instructorOf(tokens.otherOwner).delete(replyRoute),
      404,
      ErrorCode.ReplyNotFound,
    );
  });

  it("delete my review: 204, then 404; another student's DELETE never touches it (IDOR)", async (ctx) => {
    skip(ctx);
    const { foreignCourse, tokens } = fixtures();
    const path = `${V1}/me/courses/${foreignCourse.courseId}/review`;
    expectProblem(await studentOf(tokens.fresh).delete(path), 404, ErrorCode.ReviewNotFound);
    await studentOf(tokens.student).delete(path).expect(204);
    expectProblem(await studentOf(tokens.student).delete(path), 404, ErrorCode.ReviewNotFound);
    expect(await outboxTypes(foreignCourse.courseId)).toContain('ReviewDeleted.v1');
  });

  /* ------------------------------------------------------------------ wishlist */

  it('wishlist: add (204, idempotent), list, states, refusals (404/409), remove (204, idempotent)', async (ctx) => {
    skip(ctx);
    const { course, wishCourse, tokens } = fixtures();
    const shopper = studentOf(tokens.outsider);
    await shopper.put(`${V1}/me/wishlist/${wishCourse.courseId}`).expect(204);
    await shopper.put(`${V1}/me/wishlist/${wishCourse.courseId}`).expect(204);

    const page = WishlistPageSchema.parse(
      (await shopper.get(`${V1}/me/wishlist`).expect(200)).body,
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        courseId: wishCourse.courseId,
        slug: wishCourse.slug,
        available: true,
      }),
    ]);
    const states = WishlistStatesResponseSchema.parse(
      (
        await shopper
          .get(`${V1}/me/wishlist/states?courseIds=${wishCourse.courseId},${course.courseId}`)
          .expect(200)
      ).body,
    );
    expect(states.items.map((s) => s.wishlisted)).toEqual([true, false]);
    // private: another student sees nothing
    const other = WishlistPageSchema.parse(
      (await studentOf(tokens.r3).get(`${V1}/me/wishlist`).expect(200)).body,
    );
    expect(other.items).toEqual([]);

    expectProblem(
      await shopper.put(`${V1}/me/wishlist/${randomUUID()}`),
      404,
      ErrorCode.CourseNotFound,
    );
    expectProblem(
      await studentOf(tokens.student).put(`${V1}/me/wishlist/${course.courseId}`),
      409,
      ErrorCode.CourseNotWishlistable,
    );
    expectProblem(
      await studentOf(tokens.ownerAsStudent).put(`${V1}/me/wishlist/${wishCourse.courseId}`),
      409,
      ErrorCode.CourseNotWishlistable,
    );

    await shopper.delete(`${V1}/me/wishlist/${wishCourse.courseId}`).expect(204);
    await shopper.delete(`${V1}/me/wishlist/${wishCourse.courseId}`).expect(204);
    expect(
      WishlistPageSchema.parse((await shopper.get(`${V1}/me/wishlist`).expect(200)).body).items,
    ).toEqual([]);
  });
});
