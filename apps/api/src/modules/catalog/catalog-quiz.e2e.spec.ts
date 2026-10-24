// Must stay the first import: AppModule validates process.env when it is imported.
import './testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  type AuthResult,
  CategorySchema,
  CourseDetailSchema,
  CourseLandingSchema,
  CurriculumSchema,
  ErrorCode,
  LectureSchema,
  MarkdownNotAllowedProblemSchema,
  QuizAuthoringSchema,
  QuizQuestionAuthoringSchema,
  RevisionQuizSchema,
  RevisionReviewSchema,
  SectionSchema,
  SubmitCourseResponseSchema,
} from '@udemy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BearerClient,
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import {
  type Operation,
  SECTION_8,
  SECTION_8_PHASE_5_CATALOG_QUIZ,
} from '../../testing/e2e/section-8';
import { deleteCatalogTestData, insertTestAsset } from './testing/catalog-it';

/*
 * P5-T6: QUIZ authoring and the admin revision quiz through the REAL AppModule (global guards
 * in production order, the course policy, validation, problem+json), real Postgres and Redis:
 *
 * - SECTION_8_PHASE_5_CATALOG_QUIZ equals what Swagger documents and what Express serves;
 * - the authoring flow and every error code of the contract (404 / 409 / 422);
 * - IDOR: instructor B with A's course, lecture and question ids is always 404; a student is
 *   403; the admin reads the working quiz (course:read:any) but cannot write it;
 * - the answer key never leaves through a learner/public route: the landing outline and the
 *   playback routes of a QUIZ lecture (422 lecture_type_mismatch) carry none of it.
 *
 * Readiness thresholds: 1 lecture, 0 s of video (catalog-public e2e env), so a course whose only
 * lecture is a quiz can be submitted. Everything created is removed in afterAll.
 */
const V1 = '/api/v1';
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const EXPLANATION = 'Because the secret explanation says so.';
const op = ([path, method]: Operation): string => `${method.toUpperCase()} ${path}`;
/** The quiz resource paths (not the learning `quiz-attempts` routes). */
const QUIZ_PATH = /\/quiz(\/|$)/;

interface UserFx {
  readonly user: SignedUpUser;
  readonly token: AuthResult;
}

interface Fixtures {
  readonly admin: UserFx;
  readonly a: UserFx;
  readonly b: UserFx;
  readonly student: UserFx;
  readonly leafId: string;
}

describe('catalog QUIZ authoring (e2e: AppModule, Postgres, Redis)', () => {
  const e2e: E2eHarness = useE2eApp();
  const tag = randomUUID().slice(0, 8);
  const categoryIds: string[] = [];
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const available = (): boolean => e2e.pg.available && e2e.redis.available;

  const instructorA = (): BearerClient => e2e.as('instructor', fixtures().a.token.accessToken);
  const instructorB = (): BearerClient => e2e.as('instructor', fixtures().b.token.accessToken);
  const admin = (): BearerClient => e2e.as('admin', fixtures().admin.token.accessToken);
  const student = (): BearerClient => e2e.as('student', fixtures().student.token.accessToken);

  beforeAll(async () => {
    if (!available()) return;
    const adminUser = await e2e.bootstrapAdmin();
    const a = await e2e.signup();
    const b = await e2e.signup();
    const s = await e2e.signup();
    for (const u of [a, b, s]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(a.userId, adminUser.userId);
    await e2e.promoteToInstructor(b.userId, adminUser.userId);
    const adminToken = await e2e.login('admin', adminUser.email);
    const adminClient = e2e.as('admin', adminToken.accessToken);
    const group = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `Quiz ${tag}` })
          .expect(201)
      ).body,
    );
    const leaf = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `Quiz leaf ${tag}`, parentId: group.id })
          .expect(201)
      ).body,
    );
    categoryIds.push(group.id, leaf.id);
    fx = {
      admin: { user: adminUser, token: adminToken },
      a: { user: a, token: await e2e.login('instructor', a.email) },
      b: { user: b, token: await e2e.login('instructor', b.email) },
      student: { user: s, token: await e2e.login('student', s.email) },
      leafId: leaf.id,
    };
  });

  // Registered after useE2eApp, so it runs BEFORE the harness teardown (which deletes users).
  afterAll(async () => {
    if (fx === undefined || !available()) return;
    await deleteCatalogTestData(e2e.pg.db, {
      ownerIds: [fx.a.user.userId, fx.b.user.userId, fx.student.user.userId, fx.admin.user.userId],
      categoryIds,
      deleteUsers: false,
    });
  });

  /** A course of `client` with a section, a QUIZ and a VIDEO lecture (header not filled in). */
  async function buildQuizCourse(
    client: BearerClient,
  ): Promise<{ courseId: string; sectionId: string; quizId: string; videoId: string }> {
    const course = CourseDetailSchema.parse(
      (
        await client
          .post(`${V1}/instructor/courses`)
          .send({ title: `Quiz course ${tag} ${randomUUID().slice(0, 4)}` })
          .expect(201)
      ).body,
    );
    const base = `${V1}/courses/${course.id}`;
    const section = SectionSchema.parse(
      (await client.post(`${base}/sections`).send({ title: 'Section one' }).expect(201)).body,
    );
    const lecture = async (type: string, title: string): Promise<string> => {
      const created = LectureSchema.parse(
        (
          await client
            .post(`${base}/sections/${section.id}/lectures`)
            .send({ type, title })
            .expect(201)
        ).body,
      );
      return created.id;
    };
    return {
      courseId: course.id,
      sectionId: section.id,
      quizId: await lecture('QUIZ', 'Check yourself'),
      videoId: await lecture('VIDEO', 'Video'),
    };
  }

  /** Adds a complete SINGLE_CHOICE question (correct option at index `correct`). */
  async function addQuestion(
    client: BearerClient,
    quizPath: string,
    prompt: string,
    correct = 0,
  ): Promise<string> {
    const question = QuizQuestionAuthoringSchema.parse(
      (
        await client
          .post(`${quizPath}/questions`)
          .send({ kind: 'SINGLE_CHOICE', promptMd: prompt, explanationMd: EXPLANATION })
          .expect(201)
      ).body,
    );
    await client
      .put(`${quizPath}/questions/${question.id}/options`)
      .send({
        options: ['Alpha', 'Beta', 'Gamma'].map((text, i) => ({ text, isCorrect: i === correct })),
      })
      .expect(200);
    return question.id;
  }

  /* ------------------------------------------------------------------ SECTION_8 */

  describe('SECTION_8: the Phase 5 catalog quiz operations', () => {
    const quiz = SECTION_8_PHASE_5_CATALOG_QUIZ.map(op).sort();
    const others = new Set(SECTION_8.map(op).filter((o) => !quiz.includes(o)));

    it('has no duplicates', () => {
      expect(new Set(quiz).size).toBe(quiz.length);
    });

    it('equals what Swagger documents under these paths', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().get('/api/docs-json').expect(200);
      const paths = (res.body as { paths: Record<string, Record<string, unknown>> }).paths;
      const documented = Object.entries(paths)
        .filter(([path]) => QUIZ_PATH.test(path))
        .flatMap(([path, item]) =>
          Object.keys(item)
            .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
            .map((method) => op([path, method])),
        )
        .filter((o) => !others.has(o))
        .sort();
      expect(documented).toEqual(quiz);
    });

    it('equals the quiz routes Express serves (nothing undocumented hides)', (ctx) => {
      e2e.skip(ctx);
      const served = expressRoutes(e2e.app.getHttpAdapter().getInstance())
        .filter(([path]) => path.startsWith(`${V1}/`) && QUIZ_PATH.test(path))
        .map(op)
        .filter((o) => !others.has(o));
      expect([...new Set(served)].sort()).toEqual(quiz);
    });
  });

  /* ------------------------------------------------------------------ authoring */

  it('authoring flow: settings, questions, options, order; version bumps; curriculum summary', async (ctx) => {
    e2e.skip(ctx);
    const client = instructorA();
    const c = await buildQuizCourse(client);
    const quizPath = `${V1}/courses/${c.courseId}/lectures/${c.quizId}/quiz`;

    const empty = QuizAuthoringSchema.parse((await client.get(quizPath).expect(200)).body);
    expect(empty).toMatchObject({ passPct: 70, questions: [], locked: false });

    const settings = QuizAuthoringSchema.parse(
      (await client.put(quizPath).send({ passPct: 80 }).expect(200)).body,
    );
    expect(settings.passPct).toBe(80);
    expect(settings.version).toBe(empty.version + 1);

    const q1 = await addQuestion(client, quizPath, 'First question');
    const q2 = await addQuestion(client, quizPath, 'Second question', 2);
    const patched = QuizQuestionAuthoringSchema.parse(
      (
        await client
          .patch(`${quizPath}/questions/${q2}`)
          .send({ kind: 'MULTIPLE_CHOICE', explanationMd: null })
          .expect(200)
      ).body,
    );
    expect(patched).toMatchObject({ kind: 'MULTIPLE_CHOICE', explanationMd: null, complete: true });

    const reordered = QuizAuthoringSchema.parse(
      (
        await client
          .put(`${quizPath}/order`)
          .send({ questionIds: [q2, q1] })
          .expect(200)
      ).body,
    );
    expect(reordered.questions.map((q) => q.id)).toEqual([q2, q1]);
    expect(reordered.questions[1]?.options).toEqual([
      { position: 0, text: 'Alpha', isCorrect: true },
      { position: 1, text: 'Beta', isCorrect: false },
      { position: 2, text: 'Gamma', isCorrect: false },
    ]);

    await client.delete(`${quizPath}/questions/${q2}`).expect(204);
    const after = QuizAuthoringSchema.parse((await client.get(quizPath).expect(200)).body);
    expect(after.questions.map((q) => [q.id, q.position])).toEqual([[q1, 0]]);

    const curriculum = CurriculumSchema.parse(
      (await client.get(`${V1}/courses/${c.courseId}/curriculum`).expect(200)).body,
    );
    const quizLecture = curriculum.sections[0]?.lectures.find((l) => l.id === c.quizId);
    expect(quizLecture?.quiz).toEqual({ passPct: 80, questionCount: 1 });
  });

  it('error codes: 422 type/options/markdown/limit, 404 question, 409 order', async (ctx) => {
    e2e.skip(ctx);
    const client = instructorA();
    const c = await buildQuizCourse(client);
    const quizPath = `${V1}/courses/${c.courseId}/lectures/${c.quizId}/quiz`;
    const videoQuiz = `${V1}/courses/${c.courseId}/lectures/${c.videoId}/quiz`;

    expectProblem(await client.get(videoQuiz), 422, ErrorCode.LectureTypeMismatch);
    expectProblem(
      await client.post(`${videoQuiz}/questions`).send({ kind: 'SINGLE_CHOICE', promptMd: 'x' }),
      422,
      ErrorCode.LectureTypeMismatch,
    );
    const q = await addQuestion(client, quizPath, 'Only question');
    expectProblem(
      await client
        .put(`${quizPath}/questions/${q}/options`)
        .send({ options: [{ text: 'Alone', isCorrect: true }] }),
      400,
      ErrorCode.ValidationFailed,
    );
    const md = expectProblem(
      await client
        .post(`${quizPath}/questions`)
        .send({ kind: 'SINGLE_CHOICE', promptMd: 'Look <img src=x onerror=alert(1)>' }),
      422,
      ErrorCode.MarkdownNotAllowed,
    );
    expect(MarkdownNotAllowedProblemSchema.parse(md).issues[0]?.path).toBe('promptMd');
    expectProblem(
      await client.patch(`${quizPath}/questions/${randomUUID()}`).send({ promptMd: 'x' }),
      404,
      ErrorCode.QuizQuestionNotFound,
    );
    expectProblem(
      await client.put(`${quizPath}/order`).send({ questionIds: [] }),
      409,
      ErrorCode.OrderMismatch,
    );
    expectProblem(
      await client
        .patch(`${V1}/courses/${c.courseId}/lectures/${c.quizId}`)
        .send({ isPreview: true }),
      422,
      ErrorCode.PreviewNotAllowed,
    );
    for (let i = 1; i < 50; i += 1) {
      await client
        .post(`${quizPath}/questions`)
        .send({ kind: 'SINGLE_CHOICE', promptMd: `Q${i}` })
        .expect(201);
    }
    expectProblem(
      await client.post(`${quizPath}/questions`).send({ kind: 'SINGLE_CHOICE', promptMd: 'Q51' }),
      422,
      ErrorCode.QuizLimitExceeded,
    );
  });

  it('IDOR: B gets 404 for every A id; a student 403; the admin reads but cannot write', async (ctx) => {
    e2e.skip(ctx);
    const a = await buildQuizCourse(instructorA());
    const b = await buildQuizCourse(instructorB());
    const aQuiz = `${V1}/courses/${a.courseId}/lectures/${a.quizId}/quiz`;
    const q = await addQuestion(instructorA(), aQuiz, 'A question');
    // B's own course with A's lecture and question ids
    const mixedQuiz = `${V1}/courses/${b.courseId}/lectures/${a.quizId}/quiz`;
    const bQuiz = `${V1}/courses/${b.courseId}/lectures/${b.quizId}/quiz`;
    const routes: [HttpMethod, string, object?][] = [
      ['get', aQuiz],
      ['put', aQuiz, { passPct: 10 }],
      ['post', `${aQuiz}/questions`, { kind: 'SINGLE_CHOICE', promptMd: 'x' }],
      ['patch', `${aQuiz}/questions/${q}`, { promptMd: 'x' }],
      ['delete', `${aQuiz}/questions/${q}`],
      [
        'put',
        `${aQuiz}/questions/${q}/options`,
        {
          options: [
            { text: 'a', isCorrect: true },
            { text: 'b', isCorrect: false },
          ],
        },
      ],
      ['put', `${aQuiz}/order`, { questionIds: [q] }],
      ['get', mixedQuiz],
      ['patch', `${bQuiz}/questions/${q}`, { promptMd: 'x' }],
      ['delete', `${bQuiz}/questions/${q}`],
    ];
    for (const [method, path, body] of routes) {
      const res = await instructorB().call(method, path).send(body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    for (const [method, path, body] of routes.slice(0, 7)) {
      expectProblem(await student().call(method, path).send(body), 403);
    }
    QuizAuthoringSchema.parse((await admin().get(aQuiz).expect(200)).body);
    expectProblem(await admin().put(aQuiz).send({ passPct: 10 }), 403);
    // nothing changed
    const quiz = QuizAuthoringSchema.parse((await instructorA().get(aQuiz).expect(200)).body);
    expect(quiz).toMatchObject({ passPct: 70, questions: [{ id: q, promptMd: 'A question' }] });
  });

  /* ------------------------------------------------- moderation and the answer key */

  it('submit -> locked (409) -> admin revision quiz with keys -> approve -> no key on public routes', async (ctx) => {
    e2e.skip(ctx);
    const client = instructorA();
    const c = await buildQuizCourse(client);
    const base = `${V1}/courses/${c.courseId}`;
    const quizPath = `${base}/lectures/${c.quizId}/quiz`;
    // only the quiz stays: the readiness thresholds are 1 lecture, 0 s of video
    await client.delete(`${base}/lectures/${c.videoId}`).expect(204);
    await client
      .patch(base)
      .send({
        subtitle: 'A subtitle for the course',
        descriptionMd: 'TypeScript from the ground up, with real projects. '.repeat(6),
        language: 'en',
        level: 'BEGINNER',
        categoryId: fixtures().leafId,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      })
      .expect(200);
    const thumbnail = await insertTestAsset(e2e.pg.db, {
      ownerId: fixtures().a.user.userId,
      purpose: 'COURSE_THUMBNAIL',
    });
    await client.put(`${base}/thumbnail`).send({ assetId: thumbnail }).expect(200);

    // empty quiz: 422 course_not_ready with QUIZ_EMPTY
    const notReady = expectProblem(await client.post(`${base}/submit`).send({}), 422);
    expect(JSON.stringify(notReady)).toContain('QUIZ_EMPTY');
    const questionId = await addQuestion(client, quizPath, 'Pick Beta', 1);

    const { revisionId } = SubmitCourseResponseSchema.parse(
      (await client.post(`${base}/submit`).send({}).expect(200)).body,
    );
    expectProblem(await client.put(quizPath).send({ passPct: 50 }), 409, ErrorCode.CourseInReview);
    expect(QuizAuthoringSchema.parse((await client.get(quizPath).expect(200)).body).locked).toBe(
      true,
    );

    const revisionQuizPath = `${V1}/admin/course-revisions/${revisionId}/lectures/${c.quizId}/quiz`;
    const revisionQuiz = RevisionQuizSchema.parse(
      (await admin().get(revisionQuizPath).expect(200)).body,
    );
    expect(revisionQuiz).toMatchObject({
      revisionId,
      lectureId: c.quizId,
      passPct: 70,
      questions: [
        {
          id: questionId,
          explanationMd: EXPLANATION,
          options: [
            { position: 0, text: 'Alpha', isCorrect: false },
            { position: 1, text: 'Beta', isCorrect: true },
            { position: 2, text: 'Gamma', isCorrect: false },
          ],
        },
      ],
    });
    expectProblem(await student().get(revisionQuizPath), 403);
    expectProblem(await client.get(revisionQuizPath), 403);
    expectProblem(
      await admin().get(`${V1}/admin/course-revisions/${randomUUID()}/lectures/${c.quizId}/quiz`),
      404,
      ErrorCode.NotFound,
    );
    expectProblem(
      await admin().get(`${V1}/admin/course-revisions/${revisionId}/lectures/${randomUUID()}/quiz`),
      404,
      ErrorCode.LectureNotFound,
    );

    const review = RevisionReviewSchema.parse(
      (await admin().get(`${V1}/admin/course-revisions/${revisionId}`).expect(200)).body,
    );
    expect(review.revision.sections[0]?.lectures[0]?.quiz).toEqual({
      passPct: 70,
      questionCount: 1,
    });
    expect(JSON.stringify(review)).not.toMatch(/isCorrect|secret explanation/);

    await admin()
      .post(`${V1}/admin/courses/${c.courseId}/revisions/${revisionId}/approve`)
      .send({})
      .expect(200);

    // the public landing outline: the quiz by title and type only
    const course = CourseDetailSchema.parse((await client.get(base).expect(200)).body);
    const landingRes = await e2e
      .http()
      .get(`${V1}/catalog/courses/by-slug/${course.slug}`)
      .set(e2e.client('student'))
      .expect(200);
    const landing = CourseLandingSchema.parse(landingRes.body);
    expect(landing.sections[0]?.lectures).toEqual([
      {
        id: c.quizId,
        title: 'Check yourself',
        type: 'QUIZ',
        durationSeconds: null,
        isPreview: false,
      },
    ]);
    expect(JSON.stringify(landingRes.body)).not.toMatch(
      /isCorrect|correct|explanation|Beta|Pick Beta/i,
    );

    // playback routes refuse a QUIZ lecture for everyone, the owner included
    for (const path of [
      `${V1}/catalog/courses/${c.courseId}/lectures/${c.quizId}/hls/master.m3u8`,
      `${V1}/catalog/courses/${c.courseId}/lectures/${c.quizId}/article`,
      `${V1}/catalog/courses/${c.courseId}/lectures/${c.quizId}/download`,
    ]) {
      const res = await client.get(path);
      expectProblem(res, 422, ErrorCode.LectureTypeMismatch);
      expect(JSON.stringify(res.body)).not.toMatch(/isCorrect|explanation|Beta/);
    }
  });
});

/** Every route Express serves, as OpenAPI path + method. */
function expressRoutes(app: unknown): Operation[] {
  interface Layer {
    route?: { path: unknown; methods: Record<string, boolean> };
  }
  const router = (app as { router?: { stack?: Layer[] } }).router;
  if (router?.stack === undefined) throw new Error('unexpected Express internals: no app.router');
  return router.stack.flatMap((layer): Operation[] => {
    const route = layer.route;
    if (route === undefined || typeof route.path !== 'string') return [];
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    return Object.keys(route.methods)
      .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
      .map((method): Operation => [path, method]);
  });
}
