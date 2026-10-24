// Must stay the first import: AppModule validates process.env when it is imported.
import '../catalog/testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  type AuthResult,
  CompletionStateSchema,
  ErrorCode,
  PlayerBootstrapSchema,
  ProgressAckSchema,
} from '@udemy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type E2eHarness,
  expectProblem,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { deleteCatalogTestData } from '../catalog/testing/catalog-it';
import { deleteMediaTestData, useIntegrationS3 } from '../media/testing/media-it';
import { freeEnrollmentRateLimitKey } from '../enrollment/infrastructure/redis-free-enrollment-rate-limiter';
import {
  createTestCategory,
  deleteEnrollmentTestData,
  type PublishedTestCourse,
  publishTestCourse,
  setTestCoursePrice,
} from '../enrollment/testing/enrollment-it';
import { ProgressFlushJob } from './application/progress-flush.job';
import { learningRateLimitKey } from './infrastructure/redis-learning-rate-limiter';
import { accessCacheKey } from './infrastructure/redis-access-cache';
import { RedisProgressKeys } from './infrastructure/redis-progress.scripts';
import {
  deleteLearningTestData,
  deleteRedisPrefix,
  learningEventTypes,
} from './testing/learning-it';

/*
 * P5-T10 over HTTP through the real AppModule (Postgres, Redis, MinIO): a published free course
 * with two 9 s videos (2 buckets each), a free enrollment, then the player routes:
 *
 * - bootstrap LEARNER / PREVIEW (owner) / 403 (stranger) / 403 (instructor-app token);
 * - heartbeats complete a video at 90 % coverage, the second completes the course (outbox);
 * - IDOR: a lecture of ANOTHER course through this course's path is 404;
 * - 422 completion_not_allowed (manual on a video), 429 on the heartbeat limit;
 * - un-completing keeps the course completion;
 * - the app's ProgressFlushJob writes the buffered progress (the buffer under a per-file prefix).
 */
const V1 = '/api/v1';
const prefix = `it:lrn-e2e:${randomUUID().slice(0, 8)}:`;

describe('learning player (e2e: AppModule, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp({
    overrides: [{ provide: RedisProgressKeys, useValue: new RedisProgressKeys(prefix) }],
  });
  const s3 = useIntegrationS3();
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const courseIds: string[] = [];
  const categoryIds: string[] = [];
  let fx:
    | {
        owner: SignedUpUser;
        learner: SignedUpUser;
        tokens: {
          learner: AuthResult;
          stranger: AuthResult;
          owner: AuthResult;
          instructor: AuthResult;
        };
        course: PublishedTestCourse;
        other: PublishedTestCourse;
      }
    | undefined;

  const available = (): boolean =>
    e2e.pg.available && e2e.redis.available && s3.unavailableReason === undefined;
  const get = <T>(token: abstract new (...args: never[]) => T): T =>
    e2e.app.get(token, { strict: false });
  const fixtures = () => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    e2e.skip(ctx);
    s3.skipIfUnavailable(ctx);
  };

  beforeAll(async () => {
    if (!available()) return;
    const admin = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    const learner = await e2e.signup();
    const stranger = await e2e.signup();
    for (const u of [owner, learner, stranger]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(owner.userId, admin.userId);
    userIds.push(admin.userId, owner.userId, learner.userId, stranger.userId);
    categoryIds.push(...(await createTestCategory(get, `lrn-${tag}`)));
    const publish = (title: string) =>
      publishTestCourse(get, e2e.pg.db, s3.storage, {
        ownerId: owner.userId,
        adminId: admin.userId,
        categoryId: categoryIds[0]!,
        title,
      });
    const course = await publish(`Learning IT ${tag}`);
    const other = await publish(`Learning IT other ${tag}`);
    courseIds.push(course.courseId, other.courseId);
    await setTestCoursePrice(e2e.pg.db, course.courseId, '0.00', owner.userId);
    const tokens = {
      learner: await e2e.login('student', learner.email),
      stranger: await e2e.login('student', stranger.email),
      owner: await e2e.login('student', owner.email),
      instructor: await e2e.login('instructor', owner.email),
    };
    await e2e
      .as('student', tokens.learner.accessToken)
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: course.courseId })
      .expect(201);
    fx = { owner, learner, tokens, course, other };
  });

  afterAll(async () => {
    if (!available()) return;
    await deleteRedisPrefix(e2e.redis.redis, prefix);
    const keys = userIds.flatMap((u) => [
      learningRateLimitKey('heartbeat', u),
      learningRateLimitKey('completionToggle', u),
      freeEnrollmentRateLimitKey(u),
      ...courseIds.map((c) => accessCacheKey(u, c)),
    ]);
    if (keys.length > 0) await e2e.redis.redis.del(...keys);
    await deleteLearningTestData(e2e.pg.db, userIds);
    await deleteEnrollmentTestData(e2e.pg.db, { userIds, courseIds });
    await deleteMediaTestData(e2e.pg.db, userIds, { storage: s3.storage });
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: userIds, categoryIds, deleteUsers: false });
  });

  const learnPath = (courseId: string) => `${V1}/me/courses/${courseId}/learn`;
  const lecturePath = (courseId: string, lectureId: string, what: 'progress' | 'completion') =>
    `${V1}/me/courses/${courseId}/lectures/${lectureId}/${what}`;

  it('bootstrap: LEARNER with an enrollment, PREVIEW for the owner, 403 otherwise', async (ctx) => {
    skip(ctx);
    const { tokens, course, owner } = fixtures();
    const res = await e2e
      .as('student', tokens.learner.accessToken)
      .get(learnPath(course.courseId))
      .expect(200);
    const body = PlayerBootstrapSchema.parse(res.body);
    expect(body).toMatchObject({
      courseId: course.courseId,
      mode: 'LEARNER',
      liveRevisionId: course.revisionId,
      instructor: { id: owner.userId },
      progress: { completed: 0, total: 2, pct: 0 },
      completedAt: null,
      certificate: null,
    });
    expect(body.resume?.lectureId).toBe(course.previewVideoId);

    const preview = await e2e
      .as('student', tokens.owner.accessToken)
      .get(learnPath(course.courseId))
      .expect(200);
    expect(PlayerBootstrapSchema.parse(preview.body)).toMatchObject({
      mode: 'PREVIEW',
      resume: null,
    });

    expectProblem(
      await e2e.as('student', tokens.stranger.accessToken).get(learnPath(course.courseId)),
      403,
      ErrorCode.EnrollmentRequired,
    );
    // learning:participate exists in the student app only
    expectProblem(
      await e2e.as('instructor', tokens.instructor.accessToken).get(learnPath(course.courseId)),
      403,
    );
    expectProblem(
      await e2e.as('student', tokens.learner.accessToken).get(learnPath(randomUUID())),
      404,
      ErrorCode.CourseNotFound,
    );
  });

  it('heartbeats complete each video at 90 %, the last one completes the course (outbox)', async (ctx) => {
    skip(ctx);
    const { tokens, course, learner } = fixtures();
    const student = e2e.as('student', tokens.learner.accessToken);
    const first = await student
      .put(lecturePath(course.courseId, course.previewVideoId, 'progress'))
      .send({ positionSeconds: 9, ranges: [{ from: 0, to: 9 }] })
      .expect(200);
    expect(ProgressAckSchema.parse(first.body)).toEqual({
      lectureCompleted: true,
      courseCompleted: false,
      coursePct: 50,
    });
    const second = await student
      .put(lecturePath(course.courseId, course.lockedVideoId, 'progress'))
      .send({ positionSeconds: 9, ranges: [{ from: 0, to: 9 }] })
      .expect(200);
    expect(second.body).toEqual({ lectureCompleted: true, courseCompleted: true, coursePct: 100 });

    const types = await learningEventTypes(e2e.pg.db, learner.userId);
    expect(types.filter((t) => t === 'LectureCompleted.v1')).toHaveLength(2);
    expect(types.filter((t) => t === 'CourseCompleted.v1')).toHaveLength(1);

    const boot = PlayerBootstrapSchema.parse(
      (await student.get(learnPath(course.courseId)).expect(200)).body,
    );
    expect(boot.progress).toEqual({ completed: 2, total: 2, pct: 100 });
    expect(boot.completedAt).not.toBeNull();
    expect(boot.sections[0]!.lectures.every((l) => l.completed && l.coveragePct === 100)).toBe(
      true,
    );
    expect(boot.resume?.lectureId).toBe(course.lockedVideoId);

    // the app's ProgressFlushJob drains the buffer into Postgres
    await get(ProgressFlushJob).drain();
    const rows = await e2e.pg.db
      .selectFrom('learning.lectureProgress')
      .select(['lectureId', 'positionSeconds'])
      .where('userId', '=', learner.userId)
      .orderBy('lectureId')
      .execute();
    expect(rows.map((r) => r.positionSeconds)).toEqual([9, 9]);
  });

  it('un-completing keeps the course completion (P5-D3)', async (ctx) => {
    skip(ctx);
    const { tokens, course } = fixtures();
    const student = e2e.as('student', tokens.learner.accessToken);
    const res = await student
      .delete(lecturePath(course.courseId, course.lockedVideoId, 'completion'))
      .expect(200);
    const state = CompletionStateSchema.parse(res.body);
    expect(state).toMatchObject({
      completed: false,
      progress: { completed: 1, total: 2, pct: 50 },
    });
    expect(state.courseCompletedAt).not.toBeNull();
  });

  it('IDOR and rule errors: 404 foreign lecture, 422 manual video, 403 owner writes', async (ctx) => {
    skip(ctx);
    const { tokens, course, other } = fixtures();
    const student = e2e.as('student', tokens.learner.accessToken);
    expectProblem(
      await student
        .put(lecturePath(course.courseId, other.lockedVideoId, 'progress'))
        .send({ positionSeconds: 1, ranges: [] }),
      404,
      ErrorCode.LectureNotFound,
    );
    expectProblem(
      await student
        .post(lecturePath(course.courseId, course.previewVideoId, 'completion'))
        .send({ cause: 'MANUAL' }),
      422,
      ErrorCode.CompletionNotAllowed,
    );
    expectProblem(
      await e2e
        .as('student', tokens.owner.accessToken)
        .put(lecturePath(course.courseId, course.previewVideoId, 'progress'))
        .send({ positionSeconds: 1, ranges: [] }),
      403,
      ErrorCode.EnrollmentRequired,
    );
    // the course of another path is not enrolled: 403, not a silent write
    expectProblem(
      await student
        .put(lecturePath(other.courseId, other.lockedVideoId, 'progress'))
        .send({ positionSeconds: 1, ranges: [] }),
      403,
      ErrorCode.EnrollmentRequired,
    );
    expectProblem(
      await student.put(lecturePath(course.courseId, course.previewVideoId, 'progress')).send({
        positionSeconds: 1,
        ranges: Array.from({ length: 33 }, (_, i) => ({ from: i, to: i + 1 })),
      }),
      400,
    );
  });

  it('429 once the heartbeat limit (40/min) is used up', async (ctx) => {
    skip(ctx);
    const { tokens, course, learner } = fixtures();
    await e2e.redis.redis.set(learningRateLimitKey('heartbeat', learner.userId), '40', 'EX', 60);
    const res = await e2e
      .as('student', tokens.learner.accessToken)
      .put(lecturePath(course.courseId, course.previewVideoId, 'progress'))
      .send({ positionSeconds: 1, ranges: [] });
    expectProblem(res, 429, ErrorCode.RateLimited);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
