// Must stay the first import: AppModule validates process.env when it is imported.
import '../../testing/e2e/apply-e2e-app-env';
import { randomUUID } from 'node:crypto';
import {
  AdminCategoryTreeResponseSchema,
  ArticleSchema,
  type AuthResult,
  CategorySchema,
  type ClientApp,
  CourseDetailSchema,
  CurriculumSchema,
  ErrorCode,
  LectureSchema,
  MarkdownNotAllowedProblemSchema,
  MyCoursePageSchema,
  SectionSchema,
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
 * Catalog A endpoints (design §8) through the REAL AppModule: global guards in production
 * order, the course policy + CourseOwnership resolver, validation, the problem+json filter and
 * real Postgres. Covers the IDOR matrix of §9 (instructor B against A's course, sections,
 * lectures and assets, including B's course combined with A's child ids: always 404), students
 * (403), admin category management and `markdown_not_allowed`.
 */
const V1 = '/api/v1';

interface CourseFixture {
  courseId: string;
  sectionId: string;
  videoId: string;
  articleId: string;
  assetId: string;
}

interface Fixtures {
  users: { a: SignedUpUser; b: SignedUpUser; student: SignedUpUser; admin: SignedUpUser };
  tokens: { a: AuthResult; b: AuthResult; student: AuthResult; admin: AuthResult };
  ofA: CourseFixture;
  ofB: CourseFixture;
}

describe('catalog endpoints (e2e: real AppModule, Postgres, Redis)', () => {
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

  /** PUT is not on the shared BearerClient. */
  function put(app: ClientApp, token: string, path: string): request.Test {
    return e2e.http().put(path).set(e2e.client(app)).set('authorization', `Bearer ${token}`);
  }
  const putAsA = (path: string): request.Test =>
    put('instructor', fixtures().tokens.a.accessToken, path);
  const putAsB = (path: string): request.Test =>
    put('instructor', fixtures().tokens.b.accessToken, path);

  /** A course with one section, a VIDEO and an ARTICLE lecture, plus an unattached video asset. */
  async function buildCourse(
    client: BearerClient,
    user: SignedUpUser,
    title: string,
  ): Promise<CourseFixture> {
    const created = await client.post(`${V1}/instructor/courses`).send({ title }).expect(201);
    const course = CourseDetailSchema.parse(created.body);
    expect(created.headers.location).toBe(`/api/v1/courses/${course.id}`);
    const section = SectionSchema.parse(
      (
        await client
          .post(`${V1}/courses/${course.id}/sections`)
          .send({ title: 'Section one' })
          .expect(201)
      ).body,
    );
    const lecture = async (type: string, t: string): Promise<string> =>
      LectureSchema.parse(
        (
          await client
            .post(`${V1}/courses/${course.id}/sections/${section.id}/lectures`)
            .send({ type, title: t })
            .expect(201)
        ).body,
      ).id;
    return {
      courseId: course.id,
      sectionId: section.id,
      videoId: await lecture('VIDEO', 'Video lecture'),
      articleId: await lecture('ARTICLE', 'Article lecture'),
      assetId: await insertTestAsset(e2e.pg.db, { ownerId: user.userId, purpose: 'LECTURE_VIDEO' }),
    };
  }

  beforeAll(async () => {
    if (!available()) return;
    const adminUser = await e2e.bootstrapAdmin();
    const a = await e2e.signup();
    const b = await e2e.signup();
    const studentUser = await e2e.signup();
    for (const u of [a, b, studentUser]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(a.userId, adminUser.userId);
    await e2e.promoteToInstructor(b.userId, adminUser.userId);
    const tokens = {
      a: await e2e.login('instructor', a.email),
      b: await e2e.login('instructor', b.email),
      student: await e2e.login('student', studentUser.email),
      admin: await e2e.login('admin', adminUser.email),
    };
    fx = { users: { a, b, student: studentUser, admin: adminUser }, tokens } as Fixtures;
    fx.ofA = await buildCourse(instructorA(), a, `Course of A ${tag}`);
    fx.ofB = await buildCourse(instructorB(), b, `Course of B ${tag}`);
  });

  // Registered after useE2eApp, so it runs BEFORE the harness teardown (which deletes the users).
  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const { users } = fx;
    await deleteCatalogTestData(e2e.pg.db, {
      ownerIds: [users.a.userId, users.b.userId, users.student.userId, users.admin.userId],
      categoryIds,
      deleteUsers: false,
    });
  });

  describe('instructor flow', () => {
    it('creates, edits, lists and reads a course with its curriculum', async (ctx) => {
      e2e.skip(ctx);
      const { courseId, videoId, assetId } = fixtures().ofA;
      const patched = await instructorA()
        .patch(`${V1}/courses/${courseId}`)
        .send({
          subtitle: 'A subtitle for the course',
          outcomes: ['Build things', 'Ship things'],
          descriptionMd: 'Plain **markdown** with a [link](https://example.com).  ',
        })
        .expect(200);
      const detail = CourseDetailSchema.parse(patched.body);
      expect(detail).toMatchObject({ outcomes: ['Build things', 'Ship things'], badge: 'DRAFT' });
      expect(detail.descriptionMd).toBe('Plain **markdown** with a [link](https://example.com).  ');

      const stale = await instructorA()
        .patch(`${V1}/courses/${courseId}`)
        .send({ title: 'Another title', expectedVersion: 1 });
      expectProblem(stale, 409, ErrorCode.VersionConflict);

      const media = await putAsA(`${V1}/courses/${courseId}/lectures/${videoId}/media`)
        .send({ assetId })
        .expect(200);
      expect(LectureSchema.parse(media.body)).toMatchObject({
        mediaAssetId: assetId,
        asset: { status: 'READY' },
      });

      const curriculum = CurriculumSchema.parse(
        (await instructorA().get(`${V1}/courses/${courseId}/curriculum`).expect(200)).body,
      );
      expect(curriculum.totals).toMatchObject({
        sectionCount: 1,
        lectureCount: 2,
        videoSeconds: 60,
      });

      const page = MyCoursePageSchema.parse(
        (await instructorA().get(`${V1}/instructor/courses?limit=50`).expect(200)).body,
      );
      expect(page.items.map((i) => i.id)).toContain(courseId);
      expect(page.items.map((i) => i.id)).not.toContain(fixtures().ofB.courseId);
    });

    it('reorders the curriculum, and a stale order is 409 order_mismatch', async (ctx) => {
      e2e.skip(ctx);
      const { courseId, sectionId, videoId, articleId } = fixtures().ofB;
      const ok = await putAsB(`${V1}/courses/${courseId}/curriculum/order`)
        .send({ sections: [{ sectionId, lectureIds: [articleId, videoId] }] })
        .expect(200);
      expect(CurriculumSchema.parse(ok.body).sections[0]?.lectures.map((l) => l.id)).toEqual([
        articleId,
        videoId,
      ]);
      const stale = await putAsB(`${V1}/courses/${courseId}/curriculum/order`).send({
        sections: [{ sectionId, lectureIds: [articleId] }],
      });
      expectProblem(stale, 409, ErrorCode.OrderMismatch);
    });

    it('rejects <script> in markdown with 422 markdown_not_allowed', async (ctx) => {
      e2e.skip(ctx);
      const { courseId, articleId } = fixtures().ofA;
      const article = await putAsA(`${V1}/courses/${courseId}/lectures/${articleId}/article`).send({
        bodyMd: 'Hello <script>alert(1)</script>',
      });
      const problem = expectProblem(article, 422, ErrorCode.MarkdownNotAllowed);
      // errors[] stays for generic clients; issues[] is the structured contract form.
      expect(problem.errors?.[0]).toMatchObject({ path: 'bodyMd' });
      expect(problem.errors?.[0]?.message).toMatch(/raw_html/);
      const structured = MarkdownNotAllowedProblemSchema.parse(article.body);
      expect(structured.issues[0]).toMatchObject({
        path: 'bodyMd',
        line: 1,
        column: 7,
        kind: 'raw_html',
        construct: 'html_inline',
      });
      expect(structured.issues).toHaveLength(structured.errors?.length ?? 0);

      const description = await instructorA()
        .patch(`${V1}/courses/${courseId}`)
        .send({ descriptionMd: '<script>alert(1)</script>' });
      expectProblem(description, 422, ErrorCode.MarkdownNotAllowed);
      expect(MarkdownNotAllowedProblemSchema.parse(description.body).issues[0]).toMatchObject({
        path: 'descriptionMd',
        kind: 'raw_html',
        construct: 'html_block',
      });
      const lectureDescription = await instructorA()
        .patch(`${V1}/courses/${courseId}/lectures/${articleId}`)
        .send({ descriptionMd: 'See ![x](https://e.test/a.png)' });
      expectProblem(lectureDescription, 422, ErrorCode.MarkdownNotAllowed);
      expect(
        MarkdownNotAllowedProblemSchema.parse(lectureDescription.body).issues[0],
      ).toMatchObject({ path: 'descriptionMd', kind: 'image', construct: 'image' });

      const saved = await putAsA(`${V1}/courses/${courseId}/lectures/${articleId}/article`)
        .send({ bodyMd: 'Safe *text*\n' })
        .expect(200);
      expect(ArticleSchema.parse(saved.body).bodyMd).toBe('Safe *text*\n');
    });
  });

  describe('IDOR matrix (§9): instructor B never sees A’s resources (404, not 403)', () => {
    it('B on A’s course: every course and nested route is 404', async (ctx) => {
      e2e.skip(ctx);
      const { courseId, sectionId, videoId, articleId, assetId } = fixtures().ofA;
      const c = `${V1}/courses/${courseId}`;
      const b = instructorB();
      const calls: [string, () => request.Test][] = [
        ['GET course', () => b.get(c)],
        ['PATCH course', () => b.patch(c).send({ title: 'Hijacked title' })],
        ['DELETE course', () => b.delete(c)],
        ['PUT thumbnail', () => putAsB(`${c}/thumbnail`).send({ assetId })],
        ['DELETE thumbnail', () => b.delete(`${c}/thumbnail`)],
        ['GET curriculum', () => b.get(`${c}/curriculum`)],
        ['PUT order', () => putAsB(`${c}/curriculum/order`).send({ sections: [] })],
        ['POST section', () => b.post(`${c}/sections`).send({ title: 'x' })],
        ['PATCH section', () => b.patch(`${c}/sections/${sectionId}`).send({ title: 'x' })],
        ['DELETE section', () => b.delete(`${c}/sections/${sectionId}`)],
        [
          'POST lecture',
          () => b.post(`${c}/sections/${sectionId}/lectures`).send({ type: 'VIDEO', title: 'x' }),
        ],
        ['PATCH lecture', () => b.patch(`${c}/lectures/${videoId}`).send({ title: 'x' })],
        ['DELETE lecture', () => b.delete(`${c}/lectures/${videoId}`)],
        ['GET article', () => b.get(`${c}/lectures/${articleId}/article`)],
        ['PUT article', () => putAsB(`${c}/lectures/${articleId}/article`).send({ bodyMd: 'x' })],
        ['PUT media', () => putAsB(`${c}/lectures/${videoId}/media`).send({ assetId })],
        ['DELETE media', () => b.delete(`${c}/lectures/${videoId}/media`)],
      ];
      for (const [label, call] of calls) {
        const res = await call();
        expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(404);
        expectProblem(res, 404, ErrorCode.NotFound);
      }
    });

    it('B’s own course combined with A’s section / lecture / asset ids: 404', async (ctx) => {
      e2e.skip(ctx);
      const a = fixtures().ofA;
      const c = `${V1}/courses/${fixtures().ofB.courseId}`;
      const b = instructorB();
      const cases: [string, () => request.Test, string][] = [
        [
          'PATCH section',
          () => b.patch(`${c}/sections/${a.sectionId}`).send({ title: 'x' }),
          ErrorCode.SectionNotFound,
        ],
        [
          'DELETE section',
          () => b.delete(`${c}/sections/${a.sectionId}`),
          ErrorCode.SectionNotFound,
        ],
        [
          'POST lecture',
          () => b.post(`${c}/sections/${a.sectionId}/lectures`).send({ type: 'VIDEO', title: 'x' }),
          ErrorCode.SectionNotFound,
        ],
        [
          'PATCH lecture',
          () => b.patch(`${c}/lectures/${a.videoId}`).send({ title: 'x' }),
          ErrorCode.LectureNotFound,
        ],
        ['DELETE lecture', () => b.delete(`${c}/lectures/${a.videoId}`), ErrorCode.LectureNotFound],
        [
          'GET article',
          () => b.get(`${c}/lectures/${a.articleId}/article`),
          ErrorCode.LectureNotFound,
        ],
        [
          'PUT article',
          () => putAsB(`${c}/lectures/${a.articleId}/article`).send({ bodyMd: 'x' }),
          ErrorCode.LectureNotFound,
        ],
        [
          'PUT media',
          () => putAsB(`${c}/lectures/${a.videoId}/media`).send({ assetId: a.assetId }),
          ErrorCode.LectureNotFound,
        ],
        [
          'DELETE media',
          () => b.delete(`${c}/lectures/${a.videoId}/media`),
          ErrorCode.LectureNotFound,
        ],
        // B's own lecture with A's asset, and A's asset as B's thumbnail.
        [
          'attach A’s asset',
          () =>
            putAsB(`${c}/lectures/${fixtures().ofB.videoId}/media`).send({ assetId: a.assetId }),
          ErrorCode.MediaAssetNotFound,
        ],
        [
          'A’s asset as thumbnail',
          () => putAsB(`${c}/thumbnail`).send({ assetId: a.assetId }),
          ErrorCode.MediaAssetNotFound,
        ],
      ];
      for (const [label, call, code] of cases) {
        const res = await call();
        expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(404);
        expectProblem(res, 404, code);
      }
      // Nothing of A's changed.
      const curriculum = CurriculumSchema.parse(
        (await instructorA().get(`${V1}/courses/${a.courseId}/curriculum`).expect(200)).body,
      );
      expect(curriculum.sections.map((s) => s.id)).toEqual([a.sectionId]);
      expect(curriculum.sections[0]?.lectures.map((l) => l.id).sort()).toEqual(
        [a.videoId, a.articleId].sort(),
      );
    });

    it('unknown and malformed course ids are 404 too', async (ctx) => {
      e2e.skip(ctx);
      expectProblem(await instructorA().get(`${V1}/courses/${randomUUID()}`), 404);
      expectProblem(await instructorA().get(`${V1}/courses/not-a-uuid/curriculum`), 404);
    });
  });

  describe('roles', () => {
    it('a student gets 403 on instructor routes and admin categories', async (ctx) => {
      e2e.skip(ctx);
      const { courseId } = fixtures().ofA;
      expectProblem(await student().get(`${V1}/instructor/courses`), 403, ErrorCode.Forbidden);
      expectProblem(
        await student().post(`${V1}/instructor/courses`).send({ title: 'Student course' }),
        403,
      );
      expectProblem(await student().get(`${V1}/courses/${courseId}`), 403);
      expectProblem(await student().get(`${V1}/admin/categories`), 403);
    });

    it('an admin reads any course but cannot edit the working copy', async (ctx) => {
      e2e.skip(ctx);
      const { courseId } = fixtures().ofA;
      const res = await admin().get(`${V1}/courses/${courseId}`).expect(200);
      expect(CourseDetailSchema.parse(res.body).id).toBe(courseId);
      await admin().get(`${V1}/courses/${courseId}/curriculum`).expect(200);
      expectProblem(
        await admin().patch(`${V1}/courses/${courseId}`).send({ title: 'Admin title' }),
        403,
      );
      expectProblem(
        await admin().get(`${V1}/courses/${randomUUID()}`),
        404,
        ErrorCode.CourseNotFound,
      );
    });

    it('an admin manages the category tree', async (ctx) => {
      e2e.skip(ctx);
      const token = fixtures().tokens.admin.accessToken;
      const create = async (body: object) => {
        const res = await admin().post(`${V1}/admin/categories`).send(body).expect(201);
        const category = CategorySchema.parse(res.body);
        categoryIds.push(category.id);
        return category;
      };
      const g1 = await create({ name: `E2E group one ${tag}` });
      const g2 = await create({ name: `E2E group two ${tag}`, slug: `e2e-two-${tag}` });
      const leaf = await create({ name: `E2E leaf ${tag}`, parentId: g1.id });
      expect([g1.depth, leaf.depth, g2.slug]).toEqual([1, 2, `e2e-two-${tag}`]);

      expectProblem(
        await admin().post(`${V1}/admin/categories`).send({ name: 'Too deep', parentId: leaf.id }),
        422,
        ErrorCode.CategoryDepthExceeded,
      );
      expectProblem(
        await admin().post(`${V1}/admin/categories`).send({ name: 'Duplicate', slug: g2.slug }),
        409,
        ErrorCode.SlugTaken,
      );

      // Assign the leaf to a course, then it cannot be deleted.
      await instructorA()
        .patch(`${V1}/courses/${fixtures().ofA.courseId}`)
        .send({ categoryId: leaf.id })
        .expect(200);
      expectProblem(
        await admin().delete(`${V1}/admin/categories/${leaf.id}`),
        409,
        ErrorCode.CategoryInUse,
      );
      const inactive = await admin()
        .patch(`${V1}/admin/categories/${leaf.id}`)
        .send({ isActive: false })
        .expect(200);
      expect(CategorySchema.parse(inactive.body).isActive).toBe(false);
      expectProblem(
        await instructorB()
          .patch(`${V1}/courses/${fixtures().ofB.courseId}`)
          .send({ categoryId: leaf.id }),
        422,
        ErrorCode.CategoryInactive,
      );

      const moved = await admin()
        .patch(`${V1}/admin/categories/${leaf.id}`)
        .send({ parentId: g2.id })
        .expect(200);
      expect(CategorySchema.parse(moved.body)).toMatchObject({ parentId: g2.id, position: 0 });

      await put('admin', token, `${V1}/admin/categories/order`)
        .send({ parentId: g2.id, orderedIds: [leaf.id] })
        .expect(204);
      expectProblem(
        await put('admin', token, `${V1}/admin/categories/order`).send({
          parentId: g1.id,
          orderedIds: [leaf.id],
        }),
        409,
        ErrorCode.OrderMismatch,
      );

      const tree = AdminCategoryTreeResponseSchema.parse(
        (await admin().get(`${V1}/admin/categories`).expect(200)).body,
      );
      const node = tree.items.find((n) => n.id === g2.id);
      expect(node?.children).toEqual([
        expect.objectContaining({ id: leaf.id, courseCount: 1, isActive: false }),
      ]);

      await admin().delete(`${V1}/admin/categories/${g1.id}`).expect(204);
      expectProblem(
        await admin().delete(`${V1}/admin/categories/${g1.id}`),
        404,
        ErrorCode.CategoryNotFound,
      );
      // Instructors cannot manage categories.
      expectProblem(await instructorA().get(`${V1}/admin/categories`), 403);
    });
  });

  describe('delete', () => {
    it('deletes a draft (204), then it is gone for everyone', async (ctx) => {
      e2e.skip(ctx);
      const created = await instructorB()
        .post(`${V1}/instructor/courses`)
        .send({ title: `Short-lived ${tag}` })
        .expect(201);
      const id = CourseDetailSchema.parse(created.body).id;
      expectProblem(await instructorA().delete(`${V1}/courses/${id}`), 404);
      await instructorB().delete(`${V1}/courses/${id}`).expect(204);
      expectProblem(await instructorB().get(`${V1}/courses/${id}`), 404);
      expectProblem(await admin().get(`${V1}/courses/${id}`), 404, ErrorCode.CourseNotFound);
    });
  });
});
