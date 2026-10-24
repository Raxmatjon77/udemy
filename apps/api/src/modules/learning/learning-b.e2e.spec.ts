// Must stay the first import: AppModule validates process.env when it is imported.
import '../catalog/testing/apply-catalog-public-e2e-env';
import { randomUUID } from 'node:crypto';
import {
  AdminCertificateSchema,
  AdminUserCertificatesSchema,
  type AuthResult,
  CategorySchema,
  CERTIFICATE_VERIFICATION_CACHE_CONTROL,
  CertificatePageSchema,
  CertificateVerificationSchema,
  CourseDetailSchema,
  ErrorCode,
  LectureSchema,
  NotePageSchema,
  NoteSchema,
  QuizAttemptDetailSchema,
  QuizAttemptPageSchema,
  QuizAttemptSchema,
  QuizQuestionAuthoringSchema,
  SectionSchema,
  SignedUrlSchema,
  SubmitCourseResponseSchema,
  SubmitQuizAttemptResponseSchema,
} from '@udemy/contracts';
import { issueCertificate, recordCertificatePdf } from '@udemy/db';
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
  SECTION_8_PHASE_5_LEARNING_B,
} from '../../testing/e2e/section-8';
import { deleteCatalogTestData, insertTestAsset } from '../catalog/testing/catalog-it';
import { freeEnrollmentRateLimitKey } from '../enrollment/infrastructure/redis-free-enrollment-rate-limiter';
import { deleteEnrollmentTestData, setTestCoursePrice } from '../enrollment/testing/enrollment-it';
import { accessCacheKey } from './infrastructure/redis-access-cache';
import { learningRateLimitKey } from './infrastructure/redis-learning-rate-limiter';
import { deleteLearningTestData } from './testing/learning-it';

/*
 * P5-T11 over HTTP through the REAL AppModule (global guards in production order, the
 * ownership resolvers, validation, problem+json), real Postgres and Redis. A free course whose
 * only lecture is a 2-question quiz (catalog-public e2e env: 1 lecture, 0 s of video) is
 * authored, approved and enrolled into; then:
 *
 * - SECTION_8_PHASE_5_LEARNING_B equals what Swagger documents and what Express serves;
 * - the ANSWER KEY never appears before a pass: start, resume, GET of an open attempt, a failed
 *   submit, GET of the failed attempt, the retry, and still the failed one after the pass;
 * - a pass reveals keys and explanations and completes the lecture and the course;
 * - IDOR: another student gets 404 on my attempt, note and certificate; an instructor-app token
 *   gets 403 on the learner routes; a student token gets 403 on the admin routes;
 * - notes CRUD with the timestamp rule; certificates (issued here the way the worker does it):
 *   409 while the PDF renders, presigned once recorded, public verification (no session),
 *   admin revoke (cause ADMIN) after which the public PDF is 404.
 */
const V1 = '/api/v1';
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const EXPLANATION = 'The secret explanation.';
const KEY_LEAK = /isCorrect|"correct"|correctOptions":\[|explanationMd":"|secret explanation/i;
const op = ([path, method]: Operation): string => `${method.toUpperCase()} ${path}`;
const LEARNING_B_PATH =
  /\/(me\/notes|me\/courses\/\{courseId\}\/notes|quiz-attempts|me\/certificates|certificates\/\{code\}|admin\/certificates|admin\/users\/\{userId\}\/certificates)/;

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

interface Fixtures {
  readonly admin: { user: SignedUpUser; token: AuthResult };
  readonly owner: { user: SignedUpUser; token: AuthResult };
  readonly learner: { user: SignedUpUser; token: AuthResult };
  readonly stranger: { user: SignedUpUser; token: AuthResult };
  readonly courseId: string;
  readonly quizId: string;
  readonly questionIds: readonly [string, string];
}

describe('learning B: notes, quiz attempts, certificates (e2e: AppModule, Postgres, Redis)', () => {
  const e2e: E2eHarness = useE2eApp();
  const tag = randomUUID().slice(0, 8);
  const categoryIds: string[] = [];
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const available = (): boolean => e2e.pg.available && e2e.redis.available;
  const learner = (): BearerClient => e2e.as('student', fixtures().learner.token.accessToken);
  const stranger = (): BearerClient => e2e.as('student', fixtures().stranger.token.accessToken);
  const admin = (): BearerClient => e2e.as('admin', fixtures().admin.token.accessToken);
  const attemptsPath = (): string =>
    `${V1}/me/courses/${fixtures().courseId}/lectures/${fixtures().quizId}/quiz-attempts`;

  beforeAll(async () => {
    if (!available()) return;
    const adminUser = await e2e.bootstrapAdmin();
    const owner = await e2e.signup({ displayName: `Owner ${tag}` });
    const student = await e2e.signup({ displayName: `Student ${tag}` });
    const other = await e2e.signup();
    for (const u of [owner, student, other]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(owner.userId, adminUser.userId);
    const adminToken = await e2e.login('admin', adminUser.email);
    const adminClient = e2e.as('admin', adminToken.accessToken);
    const ownerToken = await e2e.login('instructor', owner.email);
    const instructor = e2e.as('instructor', ownerToken.accessToken);

    const group = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `LB ${tag}` })
          .expect(201)
      ).body,
    );
    const leaf = CategorySchema.parse(
      (
        await adminClient
          .post(`${V1}/admin/categories`)
          .send({ name: `LB leaf ${tag}`, parentId: group.id })
          .expect(201)
      ).body,
    );
    categoryIds.push(group.id, leaf.id);

    // a course whose only lecture is a 2-question quiz
    const course = CourseDetailSchema.parse(
      (
        await instructor
          .post(`${V1}/instructor/courses`)
          .send({ title: `Quiz ${tag}` })
          .expect(201)
      ).body,
    );
    const base = `${V1}/courses/${course.id}`;
    const section = SectionSchema.parse(
      (await instructor.post(`${base}/sections`).send({ title: 'Only section' }).expect(201)).body,
    );
    const quiz = LectureSchema.parse(
      (
        await instructor
          .post(`${base}/sections/${section.id}/lectures`)
          .send({ type: 'QUIZ', title: 'Check yourself' })
          .expect(201)
      ).body,
    );
    const quizPath = `${base}/lectures/${quiz.id}/quiz`;
    const addQuestion = async (prompt: string, correct: number): Promise<string> => {
      const question = QuizQuestionAuthoringSchema.parse(
        (
          await instructor
            .post(`${quizPath}/questions`)
            .send({ kind: 'SINGLE_CHOICE', promptMd: prompt, explanationMd: EXPLANATION })
            .expect(201)
        ).body,
      );
      await instructor
        .put(`${quizPath}/questions/${question.id}/options`)
        .send({
          options: ['Alpha', 'Beta', 'Gamma'].map((text, i) => ({
            text,
            isCorrect: i === correct,
          })),
        })
        .expect(200);
      return question.id;
    };
    const q1 = await addQuestion('Pick Beta', 1);
    const q2 = await addQuestion('Pick Gamma', 2);
    await instructor
      .patch(base)
      .send({
        subtitle: 'A subtitle for the course',
        descriptionMd: 'Quizzes from the ground up, with real projects. '.repeat(6),
        language: 'en',
        level: 'BEGINNER',
        categoryId: leaf.id,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      })
      .expect(200);
    const thumbnail = await insertTestAsset(e2e.pg.db, {
      ownerId: owner.userId,
      purpose: 'COURSE_THUMBNAIL',
    });
    await instructor.put(`${base}/thumbnail`).send({ assetId: thumbnail }).expect(200);
    const { revisionId } = SubmitCourseResponseSchema.parse(
      (await instructor.post(`${base}/submit`).send({}).expect(200)).body,
    );
    await adminClient
      .post(`${V1}/admin/courses/${course.id}/revisions/${revisionId}/approve`)
      .send({})
      .expect(200);
    await setTestCoursePrice(e2e.pg.db, course.id, '0.00', owner.userId);

    const learnerToken = await e2e.login('student', student.email);
    await e2e
      .as('student', learnerToken.accessToken)
      .post(`${V1}/me/free-enrollments`)
      .send({ courseId: course.id })
      .expect(201);

    fx = {
      admin: { user: adminUser, token: adminToken },
      owner: { user: owner, token: ownerToken },
      learner: { user: student, token: learnerToken },
      stranger: { user: other, token: await e2e.login('student', other.email) },
      courseId: course.id,
      quizId: quiz.id,
      questionIds: [q1, q2],
    };
  });

  // Registered after useE2eApp, so it runs BEFORE the harness teardown (which deletes users).
  afterAll(async () => {
    if (fx === undefined || !available()) return;
    const users = [fx.admin, fx.owner, fx.learner, fx.stranger].map((u) => u.user.userId);
    const keys = users.flatMap((u) => [
      learningRateLimitKey('noteWrite', u),
      learningRateLimitKey('quizStart', u),
      learningRateLimitKey('quizSubmit', u),
      freeEnrollmentRateLimitKey(u),
      accessCacheKey(u, fixtures().courseId),
    ]);
    await e2e.redis.redis.del(...keys);
    await deleteLearningTestData(e2e.pg.db, users);
    await deleteEnrollmentTestData(e2e.pg.db, { userIds: users, courseIds: [fx.courseId] });
    await deleteCatalogTestData(e2e.pg.db, { ownerIds: users, categoryIds, deleteUsers: false });
  });

  /* ------------------------------------------------------------------ SECTION_8 */

  describe('SECTION_8: the Phase 5 learning B operations', () => {
    const mine = SECTION_8_PHASE_5_LEARNING_B.map(op).sort();
    const others = new Set(SECTION_8.map(op).filter((o) => !mine.includes(o)));

    it('has no duplicates', () => {
      expect(new Set(mine).size).toBe(mine.length);
    });

    it('equals what Swagger documents under these paths', async (ctx) => {
      e2e.skip(ctx);
      const res = await e2e.http().get('/api/docs-json').expect(200);
      const paths = (res.body as { paths: Record<string, Record<string, unknown>> }).paths;
      const documented = Object.entries(paths)
        .filter(([path]) => LEARNING_B_PATH.test(path))
        .flatMap(([path, item]) =>
          Object.keys(item)
            .filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m))
            .map((method) => op([path, method])),
        )
        .filter((o) => !others.has(o))
        .sort();
      expect(documented).toEqual(mine);
    });

    it('equals the routes Express serves (nothing undocumented hides)', (ctx) => {
      e2e.skip(ctx);
      const served = expressRoutes(e2e.app.getHttpAdapter().getInstance())
        .filter(([path]) => path.startsWith(`${V1}/`) && LEARNING_B_PATH.test(path))
        .map(op)
        .filter((o) => !others.has(o));
      expect([...new Set(served)].sort()).toEqual(mine);
    });
  });

  /* ------------------------------------------------------------- quiz attempts */

  it('the answer key never leaves before a pass; a pass reveals it and completes the course', async (ctx) => {
    e2e.skip(ctx);
    const { questionIds } = fixtures();
    const [q1, q2] = questionIds;

    // start: 201, no correctness fields
    const started = await learner().post(attemptsPath()).send({}).expect(201);
    const attempt = QuizAttemptSchema.parse(started.body);
    expect(JSON.stringify(started.body)).not.toMatch(KEY_LEAK);
    expect(attempt.questions.map((q) => q.id)).toEqual([q1, q2]);

    // resume: 200, same attempt, still no key; GET of the open attempt: no key, no result
    const resumed = await learner().post(attemptsPath()).send({}).expect(200);
    expect(resumed.body.id).toBe(attempt.id);
    expect(JSON.stringify(resumed.body)).not.toMatch(KEY_LEAK);
    const open = await learner().get(`${V1}/me/quiz-attempts/${attempt.id}`).expect(200);
    expect(QuizAttemptDetailSchema.parse(open.body).result).toBeNull();
    expect(JSON.stringify(open.body)).not.toMatch(KEY_LEAK);

    // IDOR: another student cannot read or submit it
    expectProblem(await stranger().get(`${V1}/me/quiz-attempts/${attempt.id}`), 404);
    expectProblem(
      await stranger().post(`${V1}/me/quiz-attempts/${attempt.id}/submit`).send({ answers: [] }),
      404,
    );
    // 422 quiz_answers_invalid: a position out of range
    expectProblem(
      await learner()
        .post(`${V1}/me/quiz-attempts/${attempt.id}/submit`)
        .send({ answers: [{ questionId: q1, optionPositions: [5] }] }),
      422,
      ErrorCode.QuizAnswersInvalid,
    );

    // a failed submit (1 of 2 = 50 < 70): own right/wrong only
    const failedRes = await learner()
      .post(`${V1}/me/quiz-attempts/${attempt.id}/submit`)
      .send({ answers: [{ questionId: q1, optionPositions: [1] }] })
      .expect(200);
    const failed = SubmitQuizAttemptResponseSchema.parse(failedRes.body);
    expect(failed).toMatchObject({ scorePct: 50, passed: false, revealed: false });
    expect(failed.questions.map((q) => q.yourAnswerCorrect)).toEqual([true, false]);
    expect(JSON.stringify(failedRes.body)).not.toMatch(KEY_LEAK);
    const failedGet = await learner().get(`${V1}/me/quiz-attempts/${attempt.id}`).expect(200);
    expect(JSON.stringify(failedGet.body)).not.toMatch(KEY_LEAK);

    // retry: a new attempt, still no key
    const retryRes = await learner().post(attemptsPath()).send({}).expect(201);
    expect(JSON.stringify(retryRes.body)).not.toMatch(KEY_LEAK);
    const retry = QuizAttemptSchema.parse(retryRes.body);
    expect(retry.id).not.toBe(attempt.id);

    // pass: keys and explanations revealed; the only lecture completes the course
    const passedRes = await learner()
      .post(`${V1}/me/quiz-attempts/${retry.id}/submit`)
      .send({
        answers: [
          { questionId: q1, optionPositions: [1] },
          { questionId: q2, optionPositions: [2] },
        ],
      })
      .expect(200);
    const passed = SubmitQuizAttemptResponseSchema.parse(passedRes.body);
    expect(passed).toMatchObject({
      scorePct: 100,
      passed: true,
      revealed: true,
      progress: { lectureCompleted: true, courseCompleted: true, coursePct: 100 },
    });
    expect(passed.questions.map((q) => [q.correctOptions, q.explanationMd])).toEqual([
      [[1], EXPLANATION],
      [[2], EXPLANATION],
    ]);

    // the earlier failed attempt stays key-free after the pass
    const failedAfter = await learner().get(`${V1}/me/quiz-attempts/${attempt.id}`).expect(200);
    expect(JSON.stringify(failedAfter.body)).not.toMatch(KEY_LEAK);

    // the repeat submit returns the stored result
    const repeat = await learner()
      .post(`${V1}/me/quiz-attempts/${retry.id}/submit`)
      .send({ answers: [] })
      .expect(200);
    expect(repeat.body).toEqual(passedRes.body);

    const list = QuizAttemptPageSchema.parse(
      (await learner().get(attemptsPath()).expect(200)).body,
    );
    expect(list.items.map((a) => a.id)).toEqual([retry.id, attempt.id]);

    const completion = await e2e.pg.db
      .selectFrom('learning.lectureCompletions')
      .select(['cause', 'quizAttemptId'])
      .where('userId', '=', fixtures().learner.user.userId)
      .executeTakeFirstOrThrow();
    expect(completion).toEqual({ cause: 'QUIZ_PASSED', quizAttemptId: retry.id });
  });

  it('learner routes: 403 for a non-enrolled student and for an instructor-app token', async (ctx) => {
    e2e.skip(ctx);
    expectProblem(
      await stranger().post(attemptsPath()).send({}),
      403,
      ErrorCode.EnrollmentRequired,
    );
    expectProblem(
      await e2e.as('instructor', fixtures().owner.token.accessToken).post(attemptsPath()).send({}),
      403,
    );
    expectProblem(
      await learner()
        .post(`${V1}/me/courses/${fixtures().courseId}/lectures/${randomUUID()}/quiz-attempts`)
        .send({}),
      404,
      ErrorCode.LectureNotFound,
    );
  });

  /* ---------------------------------------------------------------------- notes */

  it('notes: create, list, edit, delete; IDOR 404; timestamps only on videos', async (ctx) => {
    e2e.skip(ctx);
    const { courseId, quizId } = fixtures();
    const notesPath = `${V1}/me/courses/${courseId}/notes`;
    const created = NoteSchema.parse(
      (
        await learner()
          .post(notesPath)
          .send({ lectureId: quizId, bodyMd: 'Revise **question 2**' })
          .expect(201)
      ).body,
    );
    expectProblem(
      await learner().post(notesPath).send({ lectureId: quizId, positionSeconds: 3, bodyMd: 'x' }),
      422,
      ErrorCode.ValidationFailed,
    );
    expectProblem(
      await learner().post(notesPath).send({ lectureId: quizId, bodyMd: '<b>x</b>' }),
      422,
      ErrorCode.MarkdownNotAllowed,
    );
    const page = NotePageSchema.parse(
      (await learner().get(`${notesPath}?lectureId=${quizId}`).expect(200)).body,
    );
    expect(page.items.map((n) => n.id)).toEqual([created.id]);

    expectProblem(
      await stranger().patch(`${V1}/me/notes/${created.id}`).send({ bodyMd: 'mine now' }),
      404,
    );
    expectProblem(await stranger().delete(`${V1}/me/notes/${created.id}`), 404);
    expectProblem(await stranger().get(notesPath), 403, ErrorCode.EnrollmentRequired);

    const edited = NoteSchema.parse(
      (await learner().patch(`${V1}/me/notes/${created.id}`).send({ bodyMd: 'edited' }).expect(200))
        .body,
    );
    expect(edited.bodyMd).toBe('edited');
    await learner().delete(`${V1}/me/notes/${created.id}`).expect(204);
    expectProblem(await learner().delete(`${V1}/me/notes/${created.id}`), 404);
  });

  /* --------------------------------------------------------------- certificates */

  it('certificates: pending PDF, presigned PDF, public verification, admin revoke', async (ctx) => {
    e2e.skip(ctx);
    const { learner: me, admin: adminFx, courseId } = fixtures();
    // what the worker's issuer does on CourseCompleted (the worker is not part of the api app)
    const code = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
    const issued = await e2e.pg.db.transaction().execute((trx) =>
      issueCertificate(trx, {
        userId: me.user.userId,
        courseId,
        revisionId: randomUUID(),
        publicCode: code,
        recipientName: `Student ${tag}`,
        courseTitle: `Quiz ${tag}`,
        instructorName: `Owner ${tag}`,
        sourceEventId: randomUUID(),
      }),
    );
    if (issued.outcome !== 'ISSUED') throw new Error('certificate not issued');
    const id = issued.certificateId;

    const mine = CertificatePageSchema.parse(
      (await learner().get(`${V1}/me/certificates`).expect(200)).body,
    );
    expect(mine.items).toEqual([expect.objectContaining({ id, code, pdfReady: false })]);
    expectProblem(
      await learner().get(`${V1}/me/certificates/${id}/pdf`),
      409,
      ErrorCode.CertificatePdfPending,
    );
    expectProblem(await stranger().get(`${V1}/me/certificates/${id}`), 404);

    await recordCertificatePdf(e2e.pg.db, id);
    const signed = SignedUrlSchema.parse(
      (await learner().get(`${V1}/me/certificates/${id}/pdf`).expect(200)).body,
    );
    expect(signed.url).toContain(`certificates/${id}/v1.pdf`);

    // public verification: client credentials only, no session
    const verify = await e2e
      .http()
      .get(`${V1}/certificates/${code}`)
      .set(e2e.client('student'))
      .expect(200);
    expect(verify.headers['cache-control']).toBe(CERTIFICATE_VERIFICATION_CACHE_CONTROL);
    expect(CertificateVerificationSchema.parse(verify.body)).toMatchObject({
      status: 'ACTIVE',
      pdfAvailable: true,
    });
    await e2e.http().get(`${V1}/certificates/${code}/pdf`).set(e2e.client('student')).expect(200);
    expectProblem(
      await e2e
        .http()
        .get(`${V1}/certificates/ZZZZZZZZZZZZZZZZZZZZZZZZZZ`)
        .set(e2e.client('student')),
      404,
      ErrorCode.CertificateNotFound,
    );

    // admin: a student token is 403; revoke with a reason (cause ADMIN)
    expectProblem(
      await learner()
        .post(`${V1}/admin/certificates/${id}/revoke`)
        .send({ reason: 'Plagiarised final project' }),
      403,
    );
    const revoked = AdminCertificateSchema.parse(
      (
        await admin()
          .post(`${V1}/admin/certificates/${id}/revoke`)
          .send({ reason: 'Plagiarised final project' })
          .expect(200)
      ).body,
    );
    expect(revoked.certificate.status).toBe('REVOKED');
    expect(revoked.transitions.at(-1)).toMatchObject({
      action: 'REVOKE',
      cause: 'ADMIN',
      actorId: adminFx.user.userId,
    });
    expectProblem(
      await admin()
        .post(`${V1}/admin/certificates/${id}/revoke`)
        .send({ reason: 'Plagiarised final project' }),
      409,
      ErrorCode.InvalidStateTransition,
    );
    expectProblem(
      await e2e.http().get(`${V1}/certificates/${code}/pdf`).set(e2e.client('student')),
      404,
      ErrorCode.CertificateNotFound,
    );
    const listed = AdminUserCertificatesSchema.parse(
      (await admin().get(`${V1}/admin/users/${me.user.userId}/certificates`).expect(200)).body,
    );
    expect(listed.items[0]?.transitions.map((t) => t.action)).toEqual(['ISSUE', 'REVOKE']);
    expectProblem(
      await admin().get(`${V1}/admin/users/${randomUUID()}/certificates`),
      404,
      ErrorCode.UserNotFound,
    );
  });
});
