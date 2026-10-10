// Must stay the first import: AppModule validates process.env when it is imported.
import '../catalog/testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  AdminEnrollmentResponseSchema,
  AdminUserEnrollmentsSchema,
  type AuthResult,
  EnrollmentSchema,
  ErrorCode,
  LearningCardPageSchema,
} from '@udemy/contracts';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { deleteCatalogTestData } from '../catalog/testing/catalog-it';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { freeEnrollmentRateLimitKey } from './infrastructure/redis-free-enrollment-rate-limiter';
import {
  createTestCategory,
  deleteEnrollmentTestData,
  type PublishedTestCourse,
  publishTestCourse,
  setTestCoursePrice,
} from './testing/enrollment-it';

/*
 * P4-T12 routes (design §8) through the REAL AppModule: global guards in production order
 * (client auth, throttler, Bearer bound to the BFF's app, permissions), zod validation,
 * problem+json, Postgres, Redis, MinIO. The authorization matrix runs across anonymous /
 * student / instructor / admin and a student token presented through another BFF; then the
 * student flows (free enroll, My learning) and the admin support flows (list, grant, revoke).
 */
const V1 = '/api/v1';
const REASON = 'Support ticket 4711: access after an outage';

type Who = 'anonymous' | 'student' | 'instructor' | 'admin' | 'studentViaInstructorApp';

interface Fixtures {
  users: {
    admin: SignedUpUser;
    owner: SignedUpUser;
    student: SignedUpUser;
    other: SignedUpUser;
    limited: SignedUpUser;
  };
  tokens: {
    admin: AuthResult;
    owner: AuthResult;
    student: AuthResult;
    other: AuthResult;
    limited: AuthResult;
  };
  free: PublishedTestCourse;
  freeTwo: PublishedTestCourse;
  unpriced: PublishedTestCourse;
}

describe('enrollment endpoints (e2e: AppModule, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp();
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
    fx === undefined ? [] : [fx.free.courseId, fx.freeTwo.courseId, fx.unpriced.courseId];

  /** Each caller through its own app (D6), or deliberately through the wrong one. */
  function call(who: Who, method: HttpMethod, path: string): request.Test {
    const { tokens } = fixtures();
    switch (who) {
      case 'anonymous':
        return e2e.http()[method](path).set(e2e.client('student'));
      case 'student':
        return e2e.as('student', tokens.student.accessToken).call(method, path);
      case 'instructor':
        return e2e.as('instructor', tokens.owner.accessToken).call(method, path);
      case 'admin':
        return e2e.as('admin', tokens.admin.accessToken).call(method, path);
      case 'studentViaInstructorApp':
        return e2e.as('instructor', tokens.student.accessToken).call(method, path);
    }
  }

  beforeAll(async () => {
    if (!available()) return;
    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    const student = await e2e.signup();
    const other = await e2e.signup();
    const limited = await e2e.signup();
    await e2e.promoteToInstructor(owner.userId, admin.userId);
    categoryIds.push(...(await createTestCategory(get, tag)));
    const publish = (title: string) =>
      publishTestCourse(get, e2e.pg.db, s3.storage, {
        ownerId: owner.userId,
        adminId: admin.userId,
        categoryId: categoryIds[0]!,
        title,
      });
    const free = await publish(`Enroll e2e free ${tag}`);
    const freeTwo = await publish(`Enroll e2e free two ${tag}`);
    const unpriced = await publish(`Enroll e2e unpriced ${tag}`);
    await setTestCoursePrice(e2e.pg.db, free.courseId, '0.00', owner.userId);
    await setTestCoursePrice(e2e.pg.db, freeTwo.courseId, '0.00', owner.userId);
    fx = {
      users: { admin, owner, student, other, limited },
      tokens: {
        admin: await e2e.login('admin', admin.email),
        owner: await e2e.login('instructor', owner.email),
        student: await e2e.login('student', student.email),
        other: await e2e.login('student', other.email),
        limited: await e2e.login('student', limited.email),
      },
      free,
      freeTwo,
      unpriced,
    };
  });

  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const ids = allUserIds();
    await deleteEnrollmentTestData(e2e.pg.db, { userIds: ids, courseIds: allCourseIds() });
    await e2e.redis.redis.del(...ids.map(freeEnrollmentRateLimitKey));
    await deleteMediaTestData(e2e.pg.db, ids, { storage: s3.storage });
    // The harness deletes the users themselves.
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: ids, categoryIds, deleteUsers: false });
  });

  /* ------------------------------------------------------------------ authorization matrix */

  interface Route {
    readonly method: HttpMethod;
    readonly path: () => string;
    readonly body?: () => object;
  }

  const routes: Record<string, Route> = {
    'POST /me/free-enrollments': {
      method: 'post',
      path: () => `${V1}/me/free-enrollments`,
      body: () => ({ courseId: fixtures().unpriced.courseId }),
    },
    'GET /me/enrollments': { method: 'get', path: () => `${V1}/me/enrollments` },
    'GET /admin/users/:userId/enrollments': {
      method: 'get',
      path: () => `${V1}/admin/users/${fixtures().users.other.userId}/enrollments`,
    },
    'POST /admin/enrollments': {
      method: 'post',
      path: () => `${V1}/admin/enrollments`,
      body: () => ({
        userId: fixtures().users.other.userId,
        courseId: fixtures().unpriced.courseId,
        reason: REASON,
      }),
    },
    'POST /admin/enrollments/:enrollmentId/revoke': {
      method: 'post',
      path: () => `${V1}/admin/enrollments/${randomUUID()}/revoke`,
      body: () => ({ reason: REASON }),
    },
  };

  /** Denied combinations only: allowed ones change state and are covered by the flows below. */
  const DENIED: readonly (readonly [route: string, who: Who, status: 401 | 403])[] = [
    ...Object.keys(routes).flatMap((route) => [
      [route, 'anonymous', 401] as const,
      [route, 'studentViaInstructorApp', 401] as const,
      [route, 'instructor', 403] as const,
    ]),
    // STUDENT permissions exist in the student app only; ADMIN ones in the admin app only (D6)
    ['POST /me/free-enrollments', 'admin', 403],
    ['GET /me/enrollments', 'admin', 403],
    ['GET /admin/users/:userId/enrollments', 'student', 403],
    ['POST /admin/enrollments', 'student', 403],
    ['POST /admin/enrollments/:enrollmentId/revoke', 'student', 403],
  ];

  it.for(DENIED)('%s as %s -> %i', async ([name, who, status], ctx) => {
    skip(ctx);
    const route = routes[name]!;
    const req = call(who, route.method, route.path());
    const res = route.body === undefined ? await req : await req.send(route.body());
    expectProblem(res, status);
  });

  it('nothing was written by the denied calls', async (ctx) => {
    skip(ctx);
    const rows = await e2e.pg.db
      .selectFrom('enrollment.enrollments')
      .select('id')
      .where('courseId', '=', fixtures().unpriced.courseId)
      .execute();
    expect(rows).toEqual([]);
  });

  /* ------------------------------------------------------------------ student */

  it('student: free enroll (201, then 200), then My learning shows live course cards', async (ctx) => {
    skip(ctx);
    const { free, freeTwo, users, tokens } = fixtures();
    const student = e2e.as('student', tokens.student.accessToken);

    const first = await student
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: free.courseId })
      .expect(201);
    const enrollment = EnrollmentSchema.parse(first.body);
    expect(enrollment).toMatchObject({
      userId: users.student.userId,
      courseId: free.courseId,
      status: 'ACTIVE',
      source: 'FREE',
      orderLineId: null,
    });
    const repeat = await student
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: free.courseId })
      .expect(200);
    expect(repeat.body).toEqual(first.body);
    await student
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: freeTwo.courseId })
      .expect(201);

    const page1 = LearningCardPageSchema.parse(
      (await student.get(`${V1}/me/enrollments?limit=1`).expect(200)).body,
    );
    expect(page1.items).toEqual([
      expect.objectContaining({
        courseId: freeTwo.courseId,
        slug: freeTwo.slug,
        title: freeTwo.title,
        instructor: { id: users.owner.userId, displayName: `Owner ${tag}` },
        hasThumbnail: true,
        archived: false,
        source: 'FREE',
        progress: null,
      }),
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = LearningCardPageSchema.parse(
      (
        await student
          .get(`${V1}/me/enrollments?limit=1&cursor=${page1.nextCursor ?? ''}`)
          .expect(200)
      ).body,
    );
    expect(page2.items.map((c) => [c.courseId, c.enrollmentId])).toEqual([
      [free.courseId, enrollment.id],
    ]);
    expect(page2.nextCursor).toBeNull();

    // the default page holds both; another student sees only their own (none)
    const all = LearningCardPageSchema.parse(
      (await student.get(`${V1}/me/enrollments?cursor=`).expect(200)).body,
    );
    expect(all.items).toHaveLength(2);
    const other = LearningCardPageSchema.parse(
      (await e2e.as('student', tokens.other.accessToken).get(`${V1}/me/enrollments`).expect(200))
        .body,
    );
    expect(other).toEqual({ items: [], nextCursor: null });

    expectProblem(await student.get(`${V1}/me/enrollments?limit=25`), 400);
    expectProblem(await student.get(`${V1}/me/enrollments?cursor=Zm9vYmFy`), 422);
  });

  it('student: free enroll refusals (404, 409 course_not_for_sale, 400) and the 30/h limit (429)', async (ctx) => {
    skip(ctx);
    const { unpriced, free, users, tokens } = fixtures();
    const student = e2e.as('student', tokens.other.accessToken);
    const enroll = (body: object) => student.post(`${V1}/me/free-enrollments`).send(body);

    expectProblem(await enroll({ courseId: randomUUID() }), 404, ErrorCode.CourseNotFound);
    expectProblem(await enroll({ courseId: unpriced.courseId }), 409, ErrorCode.CourseNotForSale);
    expectProblem(await enroll({ courseId: 'not-a-uuid' }), 400, ErrorCode.ValidationFailed);
    expectProblem(await enroll({}), 400, ErrorCode.ValidationFailed);

    // a user who already used up the window (30 per hour) is refused, with Retry-After
    await e2e.redis.redis.set(freeEnrollmentRateLimitKey(users.limited.userId), '30', 'PX', 60_000);
    const limited = await e2e
      .as('student', tokens.limited.accessToken)
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: free.courseId });
    expectProblem(limited, 429, ErrorCode.RateLimited);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  /* ------------------------------------------------------------------ admin */

  it('admin: grant (201) -> 409 already_enrolled -> revoke (200) -> 409 -> re-grant; the list shows the log', async (ctx) => {
    skip(ctx);
    const { unpriced, users, tokens } = fixtures();
    const admin = e2e.as('admin', tokens.admin.accessToken);
    const target = users.other.userId;
    const grantBody = { userId: target, courseId: unpriced.courseId, reason: REASON };

    // admin grants do not need a price (support access, outside commerce)
    const granted = AdminEnrollmentResponseSchema.parse(
      (await admin.post(`${V1}/admin/enrollments`).send(grantBody).expect(201)).body,
    );
    expect(granted).toMatchObject({
      userId: target,
      courseId: unpriced.courseId,
      status: 'ACTIVE',
      source: 'ADMIN',
      course: {
        id: unpriced.courseId,
        slug: unpriced.slug,
        title: unpriced.title,
        archived: false,
      },
    });
    expect(granted.transitions).toEqual([
      expect.objectContaining({
        action: 'GRANT',
        source: 'ADMIN',
        reason: REASON,
        actorId: users.admin.userId,
      }),
    ]);
    expectProblem(
      await admin.post(`${V1}/admin/enrollments`).send(grantBody),
      409,
      ErrorCode.AlreadyEnrolled,
    );

    const revokeReason = 'Revoked after the support case was closed';
    const revoke = (id: string, reason = revokeReason) =>
      admin.post(`${V1}/admin/enrollments/${id}/revoke`).send({ reason });
    const revoked = AdminEnrollmentResponseSchema.parse(
      (await revoke(granted.id).expect(200)).body,
    );
    expect(revoked).toMatchObject({ id: granted.id, status: 'REVOKED', revokeReason: 'ADMIN' });
    expect(revoked.revokedAt).not.toBeNull();
    expectProblem(await revoke(granted.id), 409, ErrorCode.InvalidStateTransition);
    expectProblem(await revoke(randomUUID()), 404, ErrorCode.EnrollmentNotFound);
    expectProblem(await revoke(granted.id, 'too short'), 400, ErrorCode.ValidationFailed);
    expectProblem(
      await admin.post(`${V1}/admin/enrollments/not-a-uuid/revoke`).send({ reason: REASON }),
      400,
    );

    const regranted = AdminEnrollmentResponseSchema.parse(
      (await admin.post(`${V1}/admin/enrollments`).send(grantBody).expect(201)).body,
    );
    expect(regranted.id).toBe(granted.id);
    expect(regranted.transitions.map((t) => t.action)).toEqual(['GRANT', 'REVOKE', 'REGRANT']);

    const list = AdminUserEnrollmentsSchema.parse(
      (await admin.get(`${V1}/admin/users/${target}/enrollments`).expect(200)).body,
    );
    expect(list.items).toEqual([regranted]);
    // the student now sees the course in My learning (source ADMIN)
    const mine = LearningCardPageSchema.parse(
      (await e2e.as('student', tokens.other.accessToken).get(`${V1}/me/enrollments`).expect(200))
        .body,
    );
    expect(mine.items.map((c) => [c.courseId, c.source])).toEqual([[unpriced.courseId, 'ADMIN']]);

    // events: Granted, Revoked, Granted (regrant) in the outbox, keyed by the enrollment
    const events = await e2e.pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', granted.id)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.type)).toEqual([
      'EnrollmentGranted.v1',
      'EnrollmentRevoked.v1',
      'EnrollmentGranted.v1',
    ]);
  });

  it('admin: 404 for unknown users and courses, 400 for a short reason', async (ctx) => {
    skip(ctx);
    const { unpriced, users, tokens } = fixtures();
    const admin = e2e.as('admin', tokens.admin.accessToken);
    expectProblem(
      await admin.get(`${V1}/admin/users/${randomUUID()}/enrollments`),
      404,
      ErrorCode.UserNotFound,
    );
    expectProblem(
      await admin
        .post(`${V1}/admin/enrollments`)
        .send({ userId: randomUUID(), courseId: unpriced.courseId, reason: REASON }),
      404,
      ErrorCode.UserNotFound,
    );
    expectProblem(
      await admin
        .post(`${V1}/admin/enrollments`)
        .send({ userId: users.limited.userId, courseId: randomUUID(), reason: REASON }),
      404,
      ErrorCode.CourseNotFound,
    );
    expectProblem(
      await admin
        .post(`${V1}/admin/enrollments`)
        .send({ userId: users.limited.userId, courseId: unpriced.courseId, reason: 'short' }),
      400,
      ErrorCode.ValidationFailed,
    );
    const empty = AdminUserEnrollmentsSchema.parse(
      (await admin.get(`${V1}/admin/users/${users.limited.userId}/enrollments`).expect(200)).body,
    );
    expect(empty).toEqual({ items: [] });
  });
});
