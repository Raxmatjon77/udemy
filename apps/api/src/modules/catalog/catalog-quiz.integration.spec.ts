// Must stay the first import: AppModule validates process.env when it is imported.
import { CATALOG_PUBLIC_IT_ENV } from './testing/apply-catalog-public-it-env';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from '@udemy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS } from '../../setup-app';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { CatalogFacade } from './application/catalog.facade';
import { QuizRepository } from './application/ports/quiz.repository';
import { RevisionRepository } from './application/ports/revision.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { AddLectureCommand } from './application/use-cases/add-lecture.command';
import { AddQuizQuestionCommand } from './application/use-cases/add-quiz-question.command';
import { AddSectionCommand } from './application/use-cases/add-section.command';
import { ApproveRevisionCommand } from './application/use-cases/approve-revision.command';
import { CreateCategoryCommand } from './application/use-cases/create-category.command';
import { CreateCourseCommand } from './application/use-cases/create-course.command';
import { DeleteLectureCommand } from './application/use-cases/delete-lecture.command';
import { GetCourseLandingQuery } from './application/use-cases/get-course-landing.query';
import { GetCourseQuery } from './application/use-cases/get-course.query';
import { GetQuizQuery } from './application/use-cases/get-quiz.query';
import { GetRevisionQuizQuery } from './application/use-cases/get-revision-quiz.query';
import { PutQuizQuestionOptionsCommand } from './application/use-cases/put-quiz-question-options.command';
import { ReorderQuizQuestionsCommand } from './application/use-cases/reorder-quiz-questions.command';
import { SetCourseThumbnailCommand } from './application/use-cases/set-course-thumbnail.command';
import { SubmitCourseCommand } from './application/use-cases/submit-course.command';
import { UpdateCourseCommand } from './application/use-cases/update-course.command';
import { UpdateQuizSettingsCommand } from './application/use-cases/update-quiz-settings.command';
import {
  CourseInReview,
  LectureTypeMismatch,
  NothingToReview,
  QuizQuestionNotFound,
} from './domain/catalog.errors';
import { contentHash } from './domain/revision-snapshot';
import {
  deleteCatalogTestData,
  insertCatalogTestUser,
  insertTestAsset,
} from './testing/catalog-it';

/*
 * P5-T6 against the integration Postgres through the real AppModule: the QUIZ working copy
 * (settings row with the lecture, deferred position unique on reorder, cascade on delete, the
 * extended working_copy_guard), the snapshot written in the submit transaction (pass mark,
 * questions, options, key; the deferred key checks at COMMIT), the canonical hash round trip
 * through the DB, the admin revision quiz, the facade reads, and the landing outline.
 * Readiness thresholds: 1 lecture, 0 s of video (catalog-public IT env).
 */
describe('catalog QUIZ (integration: real AppModule, Postgres)', () => {
  const pg = useIntegrationDatabase({ max: 6 });
  const itRedis = useIntegrationRedis();
  const owners: string[] = [];
  const categoryIds: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let app: NestExpressApplication | undefined;
  let leafId = '';
  let adminId = '';

  const get = <T>(token: abstract new (...args: never[]) => T): T => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const available = (): boolean => pg.available && itRedis.available;
  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
  };

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    await app.init();
    const group = await get(CreateCategoryCommand).execute({ name: `Quiz IT ${tag}` });
    const leaf = await get(CreateCategoryCommand).execute({
      name: `Quiz leaf ${tag}`,
      parentId: group.id,
    });
    categoryIds.push(group.id, leaf.id);
    leafId = leaf.id;
    adminId = await insertCatalogTestUser(pg.db, 'admin');
    owners.push(adminId);
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (available()) await deleteCatalogTestData(pg.db, { ownerIds: owners, categoryIds });
    } finally {
      await rm(CATALOG_PUBLIC_IT_ENV.keysDir, { recursive: true, force: true });
      process.env = CATALOG_PUBLIC_IT_ENV.savedEnv;
    }
  });

  interface QuizCourse {
    ownerId: string;
    courseId: string;
    sectionId: string;
    quizId: string;
  }

  /** A course whose only lecture is a QUIZ, with a ready header and thumbnail. */
  async function quizCourse(label: string): Promise<QuizCourse> {
    const ownerId = await insertCatalogTestUser(pg.db, label);
    owners.push(ownerId);
    const course = await get(CreateCourseCommand).execute({
      ownerId,
      title: `Quiz ${label} ${tag}`,
    });
    const as = { actorId: ownerId, courseId: course.id };
    await get(UpdateCourseCommand).execute({
      ...as,
      changes: {
        subtitle: 'A subtitle for the course',
        descriptionMd: 'TypeScript from the ground up, with real projects. '.repeat(6),
        language: 'en',
        level: 'BEGINNER',
        categoryId: leafId,
        outcomes: ['One', 'Two', 'Three', 'Four'],
      },
    });
    const thumbnail = await insertTestAsset(pg.db, { ownerId, purpose: 'COURSE_THUMBNAIL' });
    await get(SetCourseThumbnailCommand).execute({ ...as, assetId: thumbnail });
    const sectionId = (await get(AddSectionCommand).execute({ ...as, title: 'Section' })).id;
    const quizId = (
      await get(AddLectureCommand).execute({ ...as, sectionId, type: 'QUIZ', title: 'Quiz' })
    ).id;
    return { ownerId, courseId: course.id, sectionId, quizId };
  }

  async function addQuestion(
    c: QuizCourse,
    prompt: string,
    correct: readonly boolean[],
    kind: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' = 'SINGLE_CHOICE',
  ): Promise<string> {
    const as = { actorId: c.ownerId, courseId: c.courseId, lectureId: c.quizId };
    const question = await get(AddQuizQuestionCommand).execute({
      ...as,
      kind,
      promptMd: prompt,
      explanationMd: `Why: ${prompt}`,
    });
    await get(PutQuizQuestionOptionsCommand).execute({
      ...as,
      questionId: question.id,
      options: correct.map((isCorrect, i) => ({ text: `${prompt} option ${i}`, isCorrect })),
    });
    return question.id;
  }

  it('working copy: settings row with the lecture, reorder over the deferred unique, cascade', async (ctx) => {
    skip(ctx);
    const c = await quizCourse('working');
    const settings = await pg.db
      .selectFrom('catalog.lectureQuizzes')
      .select(['passPct', 'lectureType'])
      .where('lectureId', '=', c.quizId)
      .executeTakeFirst();
    expect(settings).toEqual({ passPct: 70, lectureType: 'QUIZ' });

    const ids = [
      await addQuestion(c, 'one', [true, false]),
      await addQuestion(c, 'two', [false, true]),
      await addQuestion(c, 'three', [true, true], 'MULTIPLE_CHOICE'),
    ];
    const reversed = [...ids].reverse();
    const view = await get(ReorderQuizQuestionsCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      lectureId: c.quizId,
      questionIds: reversed,
    });
    expect(view.questions.map((q) => q.id)).toEqual(reversed);
    const rows = await pg.db
      .selectFrom('catalog.quizQuestions')
      .select(['id', 'position'])
      .where('lectureId', '=', c.quizId)
      .orderBy('position')
      .execute();
    expect(rows.map((r) => r.id)).toEqual(reversed);

    // a question of another quiz is not found here
    const other = await quizCourse('working-other');
    const foreign = await addQuestion(other, 'theirs', [true, false]);
    await expect(
      get(PutQuizQuestionOptionsCommand).execute({
        actorId: c.ownerId,
        courseId: c.courseId,
        lectureId: c.quizId,
        questionId: foreign,
        options: [
          { text: 'a', isCorrect: true },
          { text: 'b', isCorrect: false },
        ],
      }),
    ).rejects.toBeInstanceOf(QuizQuestionNotFound);

    await get(DeleteLectureCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      lectureId: c.quizId,
    });
    const left = await sql<{ n: number }>`
      SELECT (SELECT count(*) FROM catalog.lecture_quizzes WHERE lecture_id = ${c.quizId})::int
           + (SELECT count(*) FROM catalog.quiz_questions WHERE lecture_id = ${c.quizId})::int
           + (SELECT count(*) FROM catalog.quiz_options WHERE question_id = ANY(${ids}::uuid[]))::int AS n
    `.execute(pg.db);
    expect(left.rows[0]?.n).toBe(0);
  });

  it('constraints: settings only on QUIZ lectures; a QUIZ lecture needs its settings at COMMIT', async (ctx) => {
    skip(ctx);
    const c = await quizCourse('constraints');
    const video = await get(AddLectureCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      sectionId: c.sectionId,
      type: 'VIDEO',
      title: 'Video',
    });
    await expect(
      get(TransactionRunner).run((trx) => get(QuizRepository).insertQuiz(trx, video.id)),
    ).rejects.toBeInstanceOf(LectureTypeMismatch);

    await expect(
      pg.db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO catalog.lectures (course_id, section_id, type, title, position)
          VALUES (${c.courseId}, ${c.sectionId}, 'QUIZ', 'No settings', 2)
        `.execute(trx);
      }),
    ).rejects.toMatchObject({ constraint: 'lecture_quizzes_required_ck' });
  });

  it('submit -> snapshot with key -> hash round trip -> approve -> facade and landing', async (ctx) => {
    skip(ctx);
    const c = await quizCourse('flow');
    const q1 = await addQuestion(c, 'single', [false, true, false]);
    const q2 = await addQuestion(c, 'multiple', [true, false, true], 'MULTIPLE_CHOICE');
    await get(UpdateQuizSettingsCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
      lectureId: c.quizId,
      passPct: 65,
    });
    const { revisionId } = await get(SubmitCourseCommand).execute({
      actorId: c.ownerId,
      courseId: c.courseId,
    });

    // the snapshot rows, written in the submit transaction
    const lecture = await pg.db
      .selectFrom('catalog.revisionLectures')
      .select(['type', 'quizPassPct', 'mediaAssetId', 'isPreview'])
      .where('revisionId', '=', revisionId)
      .where('lectureId', '=', c.quizId)
      .executeTakeFirstOrThrow();
    expect(lecture).toEqual({
      type: 'QUIZ',
      quizPassPct: 65,
      mediaAssetId: null,
      isPreview: false,
    });
    const keyRows = await pg.db
      .selectFrom('catalog.revisionQuizOptions')
      .select(['questionId', 'position', 'isCorrect'])
      .where('revisionId', '=', revisionId)
      .orderBy('questionId')
      .orderBy('position')
      .execute();
    expect(keyRows.filter((r) => r.isCorrect).map((r) => [r.questionId, r.position])).toEqual(
      expect.arrayContaining([
        [q1, 1],
        [q2, 0],
        [q2, 2],
      ]),
    );
    // a committed key can never gain rows later (revision_quiz_options_same_tx_ck)
    await expect(
      sql`
        INSERT INTO catalog.revision_quiz_options (revision_id, question_id, position, text, is_correct)
        VALUES (${revisionId}, ${q1}, 3, 'Late option', true)
      `.execute(pg.db),
    ).rejects.toMatchObject({ code: '23514', constraint: 'revision_quiz_options_same_tx_ck' });

    // the canonical hash survives the DB round trip (quiz included)
    const stored = await get(RevisionRepository).findById(revisionId);
    if (stored === null) throw new Error('revision missing');
    expect(contentHash(stored.content).toString('hex')).toBe(stored.contentHashHex);
    expect(stored.lectures.get(c.quizId)?.quiz?.questions.map((q) => q.id)).toEqual([q1, q2]);

    // locked while in review: the use case and the DB guard
    await expect(
      get(UpdateQuizSettingsCommand).execute({
        actorId: c.ownerId,
        courseId: c.courseId,
        lectureId: c.quizId,
        passPct: 90,
      }),
    ).rejects.toBeInstanceOf(CourseInReview);
    await expect(
      sql`UPDATE catalog.quiz_options SET text = 'tampered' WHERE question_id = ${q1}`.execute(
        pg.db,
      ),
    ).rejects.toMatchObject({ constraint: 'courses_working_copy_locked_ck' });
    expect(
      (await get(GetQuizQuery).execute({ courseId: c.courseId, lectureId: c.quizId })).locked,
    ).toBe(true);

    // the admin moderation view: the key, as frozen
    const revisionQuiz = await get(GetRevisionQuizQuery).execute({
      revisionId,
      lectureId: c.quizId,
    });
    expect(revisionQuiz.passPct).toBe(65);
    expect(revisionQuiz.questions[1]?.options.map((o) => o.isCorrect)).toEqual([true, false, true]);

    await get(ApproveRevisionCommand).execute({
      actorId: adminId,
      courseId: c.courseId,
      revisionId,
    });
    await expect(
      get(SubmitCourseCommand).execute({ actorId: c.ownerId, courseId: c.courseId }),
    ).rejects.toBeInstanceOf(NothingToReview);
    expect((await get(GetCourseQuery).execute(c.courseId)).hasUnpublishedChanges).toBe(false);

    // facade: outline, learner view without key, key for grading
    const facade = get(CatalogFacade);
    const curriculum = await facade.getLiveCurriculum(c.courseId);
    expect(curriculum?.sections[0]?.lectures).toEqual([
      {
        id: c.quizId,
        type: 'QUIZ',
        title: 'Quiz',
        durationSeconds: null,
        isPreview: false,
        mediaAssetId: null,
        quiz: { questionCount: 2, passPct: 65 },
      },
    ]);
    const attempt = await facade.getQuizForAttempt(c.courseId, c.quizId);
    expect(attempt?.revisionId).toBe(revisionId);
    expect(JSON.stringify(attempt)).not.toMatch(/isCorrect|"correct"|explanation|Why:/);
    const key = await facade.getQuizAnswerKey(revisionId, c.quizId);
    expect(key?.questions.map((q) => q.correct)).toEqual([[1], [0, 2]]);
    expect(await facade.getLiveLecture(c.courseId, c.quizId)).toMatchObject({
      type: 'QUIZ',
      liveRevisionId: revisionId,
      mediaAssetId: null,
    });
    expect((await facade.getLiveCurriculumIndex([c.courseId])).get(c.courseId)).toEqual({
      liveRevisionId: revisionId,
      lectureIds: [c.quizId],
      videoSecondsTotal: 0,
    });

    // the public landing outline: title and type only
    const course = await get(GetCourseQuery).execute(c.courseId);
    const landing = await get(GetCourseLandingQuery).execute(course.slug);
    expect(landing.sections[0]?.lectures).toEqual([
      { id: c.quizId, title: 'Quiz', type: 'QUIZ', durationSeconds: null, isPreview: false },
    ]);
    expect(JSON.stringify(landing)).not.toMatch(/isCorrect|explanation|option/);
  });
});
