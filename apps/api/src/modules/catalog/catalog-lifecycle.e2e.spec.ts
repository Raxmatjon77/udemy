// Must stay the first import: AppModule validates process.env when it is imported.
import '../../testing/e2e/apply-e2e-app-env';
import { randomUUID } from 'node:crypto';
import {
  AdminCoursePageSchema,
  type AuthResult,
  CategorySchema,
  type ClientApp,
  CourseDetailSchema,
  CourseHistoryResponseSchema,
  CourseNotReadyProblemSchema,
  ErrorCode,
  LectureSchema,
  ReviewQueuePageSchema,
  RevisionReviewSchema,
  SectionSchema,
  SubmitCourseResponseSchema,
} from '@udemy/contracts';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BearerClient,
  type E2eHarness,
  expectProblem,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { deleteCatalogTestData, insertTestAsset } from './testing/catalog-it';

/*
 * P2-T10 endpoints (design §8) through the REAL AppModule (guards in production order, the
 * course policy, validation, problem+json): the instructor (owner) vs other instructor vs
 * admin vs student matrix on every lifecycle and moderation route, `course_not_ready` with
 * its issues, `version_conflict`, `restore_forbidden` after a takedown, and
 * `self_decision_forbidden` for a user who is both INSTRUCTOR and ADMIN (instructor app to
 * submit, admin app to approve). Default thresholds: 5 lectures, 30 min of video.
 */
const V1 = '/api/v1';

interface Fixtures {
  users: { a: SignedUpUser; b: SignedUpUser; student: SignedUpUser; admin: SignedUpUser };
  dual: SignedUpUser;
  tokens: {
    a: AuthResult;
    b: AuthResult;
    student: AuthResult;
    admin: AuthResult;
    dualInstructor: AuthResult;
    dualAdmin: AuthResult;
  };
  leafId: string;
  courseId: string;
  articleIds: string[];
}

describe('catalog lifecycle endpoints (e2e: real AppModule, Postgres, Redis)', () => {
  const e2e: E2eHarness = useE2eApp();
  const categoryIds: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const available = (): boolean => e2e.pg.available && e2e.redis.available;

  const instructorA = (): BearerClient => e2e.as('instructor', fixtures().tokens.a.accessToken);
  const instructorB = (): BearerClient => e2e.as('instructor', fixtures().tokens.b.accessToken);
  const admin = (): BearerClient => e2e.as('admin', fixtures().tokens.admin.accessToken);
  const student = (): BearerClient => e2e.as('student', fixtures().tokens.student.accessToken);

  function put(app: ClientApp, token: string, path: string): request.Test {
    return e2e.http().put(path).set(e2e.client(app)).set('authorization', `Bearer ${token}`);
  }

  /** A course that passes the default readiness rules, built through the HTTP API. */
  async function buildReadyCourse(
    client: BearerClient,
    token: string,
    user: SignedUpUser,
    leafId: string,
  ): Promise<{ courseId: string; articleIds: string[] }> {
    const course = CourseDetailSchema.parse(
      (
        await client
          .post(`${V1}/instructor/courses`)
          .send({ title: `Lifecycle ${tag} ${randomUUID().slice(0, 4)}` })
          .expect(201)
      ).body,
    );
    const base = `${V1}/courses/${course.id}`;
    await client
      .patch(base)
      .send({
        subtitle: 'A subtitle for the course',
        descriptionMd: 'TypeScript from the ground up, with real projects. '.repeat(6),
        language: 'en',
        level: 'BEGINNER',
        categoryId: leafId,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      })
      .expect(200);
    const thumbnail = await insertTestAsset(e2e.pg.db, {
      ownerId: user.userId,
      purpose: 'COURSE_THUMBNAIL',
    });
    await put('instructor', token, `${base}/thumbnail`).send({ assetId: thumbnail }).expect(200);
    const section = SectionSchema.parse(
      (await client.post(`${base}/sections`).send({ title: 'Section one' }).expect(201)).body,
    );
    const lecture = async (type: string, title: string): Promise<string> =>
      LectureSchema.parse(
        (
          await client
            .post(`${base}/sections/${section.id}/lectures`)
            .send({ type, title })
            .expect(201)
        ).body,
      ).id;
    const videoId = await lecture('VIDEO', 'Video');
    const video = await insertTestAsset(e2e.pg.db, {
      ownerId: user.userId,
      purpose: 'LECTURE_VIDEO',
      durationMs: 1_800_000,
    });
    await put('instructor', token, `${base}/lectures/${videoId}/media`)
      .send({ assetId: video })
      .expect(200);
    const articleIds: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const id = await lecture('ARTICLE', `Article ${i}`);
      await put('instructor', token, `${base}/lectures/${id}/article`)
        .send({ bodyMd: `Article ${i}: a body that is comfortably longer than fifty characters.` })
        .expect(200);
      articleIds.push(id);
    }
    return { courseId: course.id, articleIds };
  }

  beforeAll(async () => {
    if (!available()) return;
    const adminUser = await e2e.bootstrapAdmin();
    const dual = await e2e.bootstrapAdmin();
    const a = await e2e.signup();
    const b = await e2e.signup();
    const studentUser = await e2e.signup();
    for (const u of [a, b, studentUser]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(a.userId, adminUser.userId);
    await e2e.promoteToInstructor(b.userId, adminUser.userId);
    await e2e.promoteToInstructor(dual.userId, adminUser.userId);
    const tokens = {
      a: await e2e.login('instructor', a.email),
      b: await e2e.login('instructor', b.email),
      student: await e2e.login('student', studentUser.email),
      admin: await e2e.login('admin', adminUser.email),
      dualInstructor: await e2e.login('instructor', dual.email),
      dualAdmin: await e2e.login('admin', dual.email),
    };
    const adminClient = e2e.as('admin', tokens.admin.accessToken);
    const group = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `Lc ${tag}` })
          .expect(201)
      ).body,
    );
    const leaf = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `Lc leaf ${tag}`, parentId: group.id })
          .expect(201)
      ).body,
    );
    categoryIds.push(group.id, leaf.id);
    const built = await buildReadyCourse(
      e2e.as('instructor', tokens.a.accessToken),
      tokens.a.accessToken,
      a,
      leaf.id,
    );
    fx = {
      users: { a, b, student: studentUser, admin: adminUser },
      dual,
      tokens,
      leafId: leaf.id,
      ...built,
    };
  });

  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const { users, dual } = fx;
    await deleteCatalogTestData(e2e.pg.db, {
      ownerIds: [
        users.a.userId,
        users.b.userId,
        users.student.userId,
        users.admin.userId,
        dual.userId,
      ],
      categoryIds,
      deleteUsers: false,
    });
  });

  it('course_not_ready: 422 with every readiness issue', async (ctx) => {
    e2e.skip(ctx);
    const empty = CourseDetailSchema.parse(
      (
        await instructorA()
          .post(`${V1}/instructor/courses`)
          .send({ title: `Empty course ${tag}` })
          .expect(201)
      ).body,
    );
    const res = await instructorA().post(`${V1}/courses/${empty.id}/submit`).send({});
    expectProblem(res, 422, ErrorCode.CourseNotReady);
    const problem = CourseNotReadyProblemSchema.parse(res.body);
    expect(problem.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'SUBTITLE_MISSING',
        'THUMBNAIL_MISSING',
        'TOO_FEW_OUTCOMES',
        'NO_SECTIONS',
        'TOO_FEW_LECTURES',
      ]),
    );
  });

  it('the full matrix: submit, review, decide, history, archive/takedown/restore', async (ctx) => {
    e2e.skip(ctx);
    const { courseId, articleIds } = fixtures();
    const course = `${V1}/courses/${courseId}`;

    // submit: owner only (other instructor 404, admin/student 403)
    expectProblem(await instructorB().post(`${course}/submit`).send({}), 404);
    expectProblem(await admin().post(`${course}/submit`).send({}), 403);
    expectProblem(await student().post(`${course}/submit`).send({}), 403);
    const r1 = SubmitCourseResponseSchema.parse(
      (await instructorA().post(`${course}/submit`).send({ note: 'Please review' }).expect(200))
        .body,
    );
    expectProblem(
      await instructorA().post(`${course}/submit`).send({}),
      409,
      ErrorCode.ReviewAlreadyPending,
    );

    // review queue and revision detail: admin only
    const queue = ReviewQueuePageSchema.parse(
      (await admin().get(`${V1}/admin/course-reviews?limit=100`).expect(200)).body,
    );
    expect(queue.items.find((i) => i.revisionId === r1.revisionId)).toMatchObject({
      courseId,
      kind: 'INITIAL',
      owner: { id: fixtures().users.a.userId },
    });
    expectProblem(await instructorA().get(`${V1}/admin/course-reviews`), 403);
    expectProblem(await student().get(`${V1}/admin/course-reviews`), 403);
    const review = RevisionReviewSchema.parse(
      (await admin().get(`${V1}/admin/course-revisions/${r1.revisionId}`).expect(200)).body,
    );
    expect(review.revision).toMatchObject({ state: 'PENDING', submitterNote: 'Please review' });
    expect(review.diff.baseRevisionId).toBeNull();
    expect(review.diff.fieldChanges).toEqual([]);
    expect(review.revision.category?.parent?.name).toBe(`Lc ${tag}`);
    expectProblem(await instructorA().get(`${V1}/admin/course-revisions/${r1.revisionId}`), 403);
    expectProblem(await admin().get(`${V1}/admin/course-revisions/${randomUUID()}`), 404);

    // decisions: admin only; version_conflict; reason validated
    const decide = `${V1}/admin/courses/${courseId}/revisions/${r1.revisionId}`;
    expectProblem(await instructorA().post(`${decide}/approve`).send({}), 403);
    expectProblem(
      await instructorB()
        .post(`${decide}/reject`)
        .send({ reason: 'x'.repeat(20) }),
      403,
    );
    expectProblem(
      await admin().post(`${decide}/approve`).send({ expectedVersion: 1 }),
      409,
      ErrorCode.VersionConflict,
    );
    expectProblem(await admin().post(`${decide}/reject`).send({ reason: 'short' }), 400);
    const rejected = CourseDetailSchema.parse(
      (
        await admin()
          .post(`${decide}/reject`)
          .send({ reason: 'Please add more detail to the articles.' })
          .expect(200)
      ).body,
    );
    expect(rejected).toMatchObject({ status: 'REJECTED', badge: 'REJECTED' });
    expectProblem(
      await admin().post(`${decide}/approve`).send({}),
      409,
      ErrorCode.InvalidStateTransition,
    );

    // resubmit, withdraw (owner only), resubmit, approve
    const r2 = SubmitCourseResponseSchema.parse(
      (await instructorA().post(`${course}/submit`).send({}).expect(200)).body,
    );
    expectProblem(await instructorB().post(`${course}/withdraw`), 404);
    expectProblem(await admin().post(`${course}/withdraw`), 403);
    await instructorA().post(`${course}/withdraw`).expect(200);
    expectProblem(
      await instructorA().post(`${course}/withdraw`),
      409,
      ErrorCode.InvalidStateTransition,
    );
    const r3 = SubmitCourseResponseSchema.parse(
      (await instructorA().post(`${course}/submit`).send({}).expect(200)).body,
    );
    expectProblem(
      await admin()
        .post(`${V1}/admin/courses/${courseId}/revisions/${r2.revisionId}/approve`)
        .send({}),
      409,
      ErrorCode.InvalidStateTransition,
    );
    const live = CourseDetailSchema.parse(
      (
        await admin()
          .post(`${V1}/admin/courses/${courseId}/revisions/${r3.revisionId}/approve`)
          .send({ note: 'Welcome aboard' })
          .expect(200)
      ).body,
    );
    expect(live).toMatchObject({ status: 'PUBLISHED', badge: 'LIVE', slugEditable: false });
    expectProblem(
      await instructorA().post(`${course}/submit`).send({}),
      409,
      ErrorCode.NothingToReview,
    );

    // an update is reviewed against the live revision
    await put(
      'instructor',
      fixtures().tokens.a.accessToken,
      `${course}/lectures/${articleIds[0]}/article`,
    )
      .send({ bodyMd: 'An edited article body that is still longer than fifty characters.' })
      .expect(200);
    const r4 = SubmitCourseResponseSchema.parse(
      (await instructorA().post(`${course}/submit`).send({}).expect(200)).body,
    );
    const updateReview = RevisionReviewSchema.parse(
      (await admin().get(`${V1}/admin/course-revisions/${r4.revisionId}`).expect(200)).body,
    );
    expect(updateReview.diff).toMatchObject({
      baseRevisionId: r3.revisionId,
      changedFields: [],
      fieldChanges: [],
      lectures: { changed: [articleIds[0]] },
    });

    // history: owner + admin; other instructor 404; student 403
    const ownerView = CourseHistoryResponseSchema.parse(
      (await instructorA().get(`${course}/history`).expect(200)).body,
    );
    expect(ownerView.items.find((i) => i.action === 'REJECT')?.actor).toEqual({
      id: null,
      displayName: 'Moderator',
      isModerator: true,
    });
    const adminView = CourseHistoryResponseSchema.parse(
      (await admin().get(`${course}/history`).expect(200)).body,
    );
    expect(adminView.items.find((i) => i.action === 'REJECT')?.actor).toMatchObject({
      id: fixtures().users.admin.userId,
      isModerator: true,
    });
    expectProblem(await instructorB().get(`${course}/history`), 404);
    expectProblem(await student().get(`${course}/history`), 403);

    // admin course list (owner ban flag); instructors 403
    const list = AdminCoursePageSchema.parse(
      (
        await admin()
          .get(`${V1}/admin/courses?ownerId=${fixtures().users.a.userId}&limit=50`)
          .expect(200)
      ).body,
    );
    expect(list.items.find((r) => r.id === courseId)).toMatchObject({
      badge: 'LIVE_UPDATE_PENDING',
      owner: { id: fixtures().users.a.userId, banned: false },
    });
    expectProblem(await instructorA().get(`${V1}/admin/courses`), 403);

    // archive (owner; auto-withdraws the pending update) / restore
    expectProblem(await instructorB().post(`${course}/archive`).send({}), 404);
    expectProblem(await admin().post(`${course}/archive`).send({}), 403);
    const archived = CourseDetailSchema.parse(
      (await instructorA().post(`${course}/archive`).send({ reason: 'A break' }).expect(200)).body,
    );
    expect(archived).toMatchObject({ status: 'ARCHIVED', pendingRevision: null });
    expectProblem(await instructorB().post(`${course}/restore`), 404);
    await instructorA().post(`${course}/restore`).expect(200);

    // takedown (admin only, reason >= 10) -> owner restore forbidden -> admin restore
    const takedown = `${V1}/admin/courses/${courseId}/takedown`;
    expectProblem(
      await instructorA()
        .post(takedown)
        .send({ reason: 'x'.repeat(20) }),
      403,
    );
    expectProblem(await admin().post(takedown).send({ reason: 'short' }), 400);
    await admin().post(takedown).send({ reason: 'Violates the content policy.' }).expect(200);
    const takenDown = AdminCoursePageSchema.parse(
      (
        await admin()
          .get(`${V1}/admin/courses?ownerId=${fixtures().users.a.userId}&status=ARCHIVED`)
          .expect(200)
      ).body,
    ).items.find((r) => r.id === courseId);
    expect(takenDown).toMatchObject({
      status: 'ARCHIVED',
      archivedBy: { id: fixtures().users.admin.userId, isModerator: true },
      archiveReason: 'Violates the content policy.',
    });
    expectProblem(await instructorA().post(`${course}/restore`), 403, ErrorCode.RestoreForbidden);
    expectProblem(await instructorA().post(`${V1}/admin/courses/${courseId}/restore`), 403);
    const restored = CourseDetailSchema.parse(
      (await admin().post(`${V1}/admin/courses/${courseId}/restore`).expect(200)).body,
    );
    expect(restored).toMatchObject({ status: 'PUBLISHED', badge: 'LIVE' });
    expectProblem(
      await admin().post(`${V1}/admin/courses/${courseId}/restore`),
      409,
      ErrorCode.InvalidStateTransition,
    );
  });

  it('self_decision_forbidden: an INSTRUCTOR+ADMIN cannot approve their own course', async (ctx) => {
    e2e.skip(ctx);
    const { dual, tokens, leafId } = fixtures();
    const asInstructor = e2e.as('instructor', tokens.dualInstructor.accessToken);
    const asAdmin = e2e.as('admin', tokens.dualAdmin.accessToken);
    const { courseId } = await buildReadyCourse(
      asInstructor,
      tokens.dualInstructor.accessToken,
      dual,
      leafId,
    );
    const r1 = SubmitCourseResponseSchema.parse(
      (await asInstructor.post(`${V1}/courses/${courseId}/submit`).send({}).expect(200)).body,
    );
    const decide = `${V1}/admin/courses/${courseId}/revisions/${r1.revisionId}`;
    expectProblem(
      await asAdmin.post(`${decide}/approve`).send({}),
      403,
      ErrorCode.SelfDecisionForbidden,
    );
    expectProblem(
      await asAdmin.post(`${decide}/reject`).send({ reason: 'Rejecting my own course.' }),
      403,
      ErrorCode.SelfDecisionForbidden,
    );
    // another admin can decide it
    await admin().post(`${decide}/approve`).send({}).expect(200);
  });
});
