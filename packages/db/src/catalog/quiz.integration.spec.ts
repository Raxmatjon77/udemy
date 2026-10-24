import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../generated/db';
import {
  createCategoryPair,
  createDraftCourse,
  createUser,
  type DraftCourse,
  submit,
} from '../testing/fixtures';
import {
  deferredFailure,
  deferredOk,
  expectFailure,
  rollback,
  skipUnlessMigrated,
  useIntegrationDb,
} from '../testing/it-db.mjs';
import { insertQuizRevisionLecture, type QuizQuestionSpec } from '../testing/phase5-fixtures';

/**
 * Catalog QUIZ type (migration 0005, docs/phase-5-schema-design.md §1 section 1, §2 "Catalog").
 * Every test is rolled back; COMMIT-time checks run through SET CONSTRAINTS ALL IMMEDIATE.
 *
 * It also re-runs the 0003 review-lock behaviour against the REPLACED catalog.working_copy_guard()
 * (open point 8): the 0003 spec (catalog.integration.spec.ts "review lock") runs in the same suite
 * against the same database, and this file asserts the installed function is the 0005 body and
 * that the old tables, the new quiz tables, and the archived/deleted branches are all locked.
 */
const pg = useIntegrationDb({ max: 2 });
type Trx = Transaction<DB>;

async function draftCourse(trx: Trx): Promise<DraftCourse> {
  const owner = await createUser(trx);
  const { childId } = await createCategoryPair(trx);
  return createDraftCourse(trx, { ownerId: owner, categoryId: childId });
}

/** A submitted revision (1 section, 1 ARTICLE lecture at position 0) + its section id. */
async function submittedRevision(trx: Trx): Promise<{ revisionId: string; sectionId: string }> {
  const course = await draftCourse(trx);
  const revisionId = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
  const { rows } = await sql<{ sectionId: string }>`
    SELECT section_id FROM catalog.revision_sections WHERE revision_id = ${revisionId} LIMIT 1
  `.execute(trx);
  return { revisionId, sectionId: rows[0]!.sectionId };
}

async function quizRevision(trx: Trx, questions: QuizQuestionSpec[]): Promise<void> {
  const { revisionId, sectionId } = await submittedRevision(trx);
  await insertQuizRevisionLecture(trx, { revisionId, sectionId, position: 1, questions });
}

/** A working-copy QUIZ lecture with settings, one question and two options. */
async function workingQuiz(trx: Trx, course: DraftCourse) {
  const section = await sql<{ id: string }>`
    INSERT INTO catalog.sections (course_id, title, position) VALUES (${course.courseId}, 'S0', 0) RETURNING id
  `.execute(trx);
  const sectionId = section.rows[0]!.id;
  const lecture = await sql<{ id: string }>`
    INSERT INTO catalog.lectures (course_id, section_id, type, title, position)
    VALUES (${course.courseId}, ${sectionId}, 'QUIZ', 'Quiz', 0) RETURNING id
  `.execute(trx);
  const lectureId = lecture.rows[0]!.id;
  await sql`INSERT INTO catalog.lecture_quizzes (lecture_id) VALUES (${lectureId})`.execute(trx);
  const q = await sql<{ id: string }>`
    INSERT INTO catalog.quiz_questions (lecture_id, position, kind, prompt_md)
    VALUES (${lectureId}, 0, 'SINGLE_CHOICE', 'Which?') RETURNING id
  `.execute(trx);
  const questionId = q.rows[0]!.id;
  await sql`
    INSERT INTO catalog.quiz_options (question_id, position, text, is_correct)
    VALUES (${questionId}, 0, 'Yes', true), (${questionId}, 1, 'No', false)
  `.execute(trx);
  return { sectionId, lectureId, questionId };
}

describe('revision answer key (deferred checks)', () => {
  it('a well-formed key (SINGLE 1 correct, MULTIPLE >= 1 correct) passes COMMIT', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await deferredOk(pg.db, (trx) =>
      quizRevision(trx, [
        { kind: 'SINGLE_CHOICE', correct: [true, false] },
        { kind: 'MULTIPLE_CHOICE', correct: [true, true, false, false, false, false] },
      ]),
    );
  });

  for (const [label, spec] of [
    ['1 option', { correct: [true] }],
    ['SINGLE with 0 correct', { correct: [false, false] }],
    ['SINGLE with 2 correct', { correct: [true, true, false] }],
    ['MULTIPLE with 0 correct', { kind: 'MULTIPLE_CHOICE', correct: [false, false] }],
    ['non-contiguous positions', { correct: [true, false], positions: [0, 2] }],
  ] as const) {
    it(`${label} fails at COMMIT (revision_quiz_options_key_ck)`, async (ctx) => {
      pg.skipIfUnavailable(ctx);
      await skipUnlessMigrated(pg, ctx);
      const err = await deferredFailure(pg.db, (trx) =>
        quizRevision(trx, [{ ...spec, correct: [...spec.correct] } as QuizQuestionSpec]),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'revision_quiz_options_key_ck' });
    });
  }

  it('a QUIZ revision lecture without questions fails at COMMIT (revision_lectures_quiz_complete_ck)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const err = await deferredFailure(pg.db, (trx) => quizRevision(trx, []));
    expect(err).toMatchObject({ code: '23514', constraint: 'revision_lectures_quiz_complete_ck' });
  });

  it('QUIZ snapshot shape: no media, a pass mark, never a preview', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const { revisionId, sectionId } = await submittedRevision(trx);
      const insert = (pos: number, media: string | null, pass: number | null, preview: boolean) =>
        sql`
          INSERT INTO catalog.revision_lectures (revision_id, lecture_id, section_id, position, type, title, is_preview,
                                                 media_asset_id, quiz_pass_pct)
          VALUES (${revisionId}, ${randomUUID()}, ${sectionId}, ${pos}, 'QUIZ', 'Quiz', ${preview}, ${media}, ${pass})`.execute(
          trx,
        );
      for (const [label, run, constraint] of [
        ['media', () => insert(1, randomUUID(), 70, false), 'revision_lectures_media_asset_id_ck'],
        ['no pass mark', () => insert(1, null, null, false), 'revision_lectures_quiz_pass_pct_ck'],
        ['preview', () => insert(1, null, 70, true), 'revision_lectures_is_preview_ck'],
      ] as const) {
        const err = await expectFailure(trx, run);
        expect({ label, code: err.code, constraint: err.constraint }).toEqual({
          label,
          code: '23514',
          constraint,
        });
      }
    });
  });

  it('a committed key cannot gain questions later (revision_quiz_questions_same_tx_ck)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const course = await draftCourse(trx);
      // simulates a revision submitted in an earlier transaction
      const { rows } = await sql<{ id: string }>`
        INSERT INTO catalog.course_revisions (course_id, revision_no, kind, content_hash, title, subtitle, description_md,
                                              language, level, category_id, thumbnail_asset_id, submitted_at)
        VALUES (${course.courseId}, 1, 'INITIAL', sha256('it'::bytea), 'Integration course', 'A subtitle for tests',
                repeat('x', 220), 'en', 'BEGINNER', ${course.categoryId}, ${randomUUID()}, now() - interval '1 minute')
        RETURNING id`.execute(trx);
      const revisionId = rows[0]!.id;
      const sectionId = randomUUID();
      await sql`
        INSERT INTO catalog.revision_sections (revision_id, section_id, position, title) VALUES (${revisionId}, ${sectionId}, 0, 'S0')
      `.execute(trx);
      const err = await expectFailure(trx, () =>
        insertQuizRevisionLecture(trx, {
          revisionId,
          sectionId,
          position: 0,
          questions: [{ correct: [true, false] }],
        }),
      );
      expect(err).toMatchObject({
        code: '23514',
        constraint: 'revision_quiz_questions_same_tx_ck',
      });
    });
  });

  it('snapshot quiz tables are append-only (42501), TRUNCATE included', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const { revisionId, sectionId } = await submittedRevision(trx);
      await insertQuizRevisionLecture(trx, {
        revisionId,
        sectionId,
        position: 1,
        questions: [{ correct: [true, false] }],
      });
      for (const [label, statement] of [
        [
          'update questions',
          sql`UPDATE catalog.revision_quiz_questions SET prompt_md = 'x' WHERE revision_id = ${revisionId}`,
        ],
        [
          'delete questions',
          sql`DELETE FROM catalog.revision_quiz_questions WHERE revision_id = ${revisionId}`,
        ],
        [
          'update options',
          sql`UPDATE catalog.revision_quiz_options SET is_correct = NOT is_correct WHERE revision_id = ${revisionId}`,
        ],
        [
          'delete options',
          sql`DELETE FROM catalog.revision_quiz_options WHERE revision_id = ${revisionId}`,
        ],
      ] as const) {
        const err = await expectFailure(trx, () => statement.execute(trx));
        expect({ label, code: err.code }).toEqual({ label, code: '42501' });
      }
    });
    for (const statement of [
      'TRUNCATE catalog.revision_quiz_options',
      'TRUNCATE catalog.revision_quiz_questions CASCADE',
    ]) {
      await rollback(pg.db, async (trx) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        const err = await expectFailure(trx, () => sql.raw(statement).execute(trx));
        expect({ statement, code: err.code }).toEqual({ statement, code: '42501' });
      });
    }
  });
});

describe('working-copy QUIZ lectures', () => {
  it('a QUIZ lecture without settings fails at COMMIT (lecture_quizzes_required_ck)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const err = await deferredFailure(pg.db, async (trx) => {
      const course = await draftCourse(trx);
      const { lectureId } = await workingQuiz(trx, course);
      await sql`DELETE FROM catalog.lecture_quizzes WHERE lecture_id = ${lectureId}`.execute(trx);
    });
    expect(err).toMatchObject({ code: '23514', constraint: 'lecture_quizzes_required_ck' });
  });

  it('shape CHECKs, settings only on QUIZ lectures, deferred reorder, cascade on lecture delete', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await deferredOk(pg.db, async (trx) => {
      const course = await draftCourse(trx);
      const { sectionId, lectureId, questionId } = await workingQuiz(trx, course);
      const media = await expectFailure(trx, () =>
        sql`UPDATE catalog.lectures SET media_asset_id = ${randomUUID()} WHERE id = ${lectureId}`.execute(
          trx,
        ),
      );
      expect(media).toMatchObject({ code: '23514', constraint: 'lectures_type_media_asset_id_ck' });
      const preview = await expectFailure(trx, () =>
        sql`UPDATE catalog.lectures SET is_preview = true WHERE id = ${lectureId}`.execute(trx),
      );
      expect(preview).toMatchObject({ code: '23514', constraint: 'lectures_type_is_preview_ck' });
      const article = await sql<{ id: string }>`
        INSERT INTO catalog.lectures (course_id, section_id, type, title, position)
        VALUES (${course.courseId}, ${sectionId}, 'ARTICLE', 'Article', 1) RETURNING id`.execute(
        trx,
      );
      const wrongType = await expectFailure(trx, () =>
        sql`INSERT INTO catalog.lecture_quizzes (lecture_id) VALUES (${article.rows[0]!.id})`.execute(
          trx,
        ),
      );
      expect(wrongType).toMatchObject({
        code: '23503',
        constraint: 'lecture_quizzes_lecture_id_lecture_type_fk',
      });
      const seventh = await expectFailure(trx, () =>
        sql`INSERT INTO catalog.quiz_options (question_id, position, text) VALUES (${questionId}, 6, 'Too many')`.execute(
          trx,
        ),
      );
      expect(seventh).toMatchObject({ code: '23514', constraint: 'quiz_options_position_ck' });
      // reorder two questions in one transaction (deferred unique)
      const q2 = await sql<{ id: string }>`
        INSERT INTO catalog.quiz_questions (lecture_id, position, kind, prompt_md)
        VALUES (${lectureId}, 1, 'MULTIPLE_CHOICE', 'Which ones?') RETURNING id`.execute(trx);
      await sql`UPDATE catalog.quiz_questions SET position = 1 WHERE id = ${questionId}`.execute(
        trx,
      );
      await sql`UPDATE catalog.quiz_questions SET position = 0 WHERE id = ${q2.rows[0]!.id}`.execute(
        trx,
      );
      // deleting the QUIZ lecture cascades settings -> questions -> options without tripping the guard
      await sql`DELETE FROM catalog.lectures WHERE id = ${lectureId}`.execute(trx);
      const { rows } = await sql<{ n: number }>`
        SELECT (SELECT count(*) FROM catalog.lecture_quizzes WHERE lecture_id = ${lectureId})
             + (SELECT count(*) FROM catalog.quiz_questions WHERE lecture_id = ${lectureId})
             + (SELECT count(*) FROM catalog.quiz_options WHERE question_id = ${questionId}) AS n`.execute(
        trx,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });
});

describe('0003 review lock re-run against the 0005 working_copy_guard (open point 8)', () => {
  it('the installed guard is the 0005 body (covers the quiz tables)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const { rows } = await sql<{ src: string }>`
      SELECT prosrc AS src FROM pg_proc WHERE oid = 'catalog.working_copy_guard()'::regprocedure
    `.execute(pg.db);
    expect(rows[0]!.src).toContain("TG_TABLE_NAME = 'quiz_options'");
    expect(rows[0]!.src).toContain("'lecture_articles','lecture_quizzes','quiz_questions'");
  });

  for (const lock of ['in review', 'deleted'] as const) {
    it(`blocks every working-copy child write, old tables and quiz tables, while the course is ${lock}`, async (ctx) => {
      pg.skipIfUnavailable(ctx);
      await skipUnlessMigrated(pg, ctx);
      await rollback(pg.db, async (trx) => {
        const course = await draftCourse(trx);
        const { sectionId, lectureId, questionId } = await workingQuiz(trx, course);
        const article = await sql<{ id: string }>`
          INSERT INTO catalog.lectures (course_id, section_id, type, title, position)
          VALUES (${course.courseId}, ${sectionId}, 'ARTICLE', 'Article', 1) RETURNING id`.execute(
          trx,
        );
        const articleId = article.rows[0]!.id;
        await sql`INSERT INTO catalog.lecture_articles (lecture_id, body_md) VALUES (${articleId}, 'Body')`.execute(
          trx,
        );
        await sql`
          INSERT INTO catalog.course_bullets (course_id, kind, position, text) VALUES (${course.courseId}, 'OUTCOME', 0, 'One')
        `.execute(trx);
        if (lock === 'in review') {
          await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
        } else {
          await sql`UPDATE catalog.courses SET deleted_at = now() WHERE id = ${course.courseId}`.execute(
            trx,
          );
        }
        const c = course.courseId;
        const writes: [string, ReturnType<typeof sql>][] = [
          // 0003 tables
          [
            'insert section',
            sql`INSERT INTO catalog.sections (course_id, title, position) VALUES (${c}, 'S1', 1)`,
          ],
          [
            'update section',
            sql`UPDATE catalog.sections SET title = 'S0 renamed' WHERE id = ${sectionId}`,
          ],
          [
            'update lecture',
            sql`UPDATE catalog.lectures SET title = 'Renamed' WHERE id = ${articleId}`,
          ],
          ['delete lecture', sql`DELETE FROM catalog.lectures WHERE id = ${articleId}`],
          [
            'update article',
            sql`UPDATE catalog.lecture_articles SET body_md = 'New' WHERE lecture_id = ${articleId}`,
          ],
          [
            'delete article',
            sql`DELETE FROM catalog.lecture_articles WHERE lecture_id = ${articleId}`,
          ],
          [
            'insert bullet',
            sql`INSERT INTO catalog.course_bullets (course_id, kind, position, text) VALUES (${c}, 'OUTCOME', 1, 'Two')`,
          ],
          ['delete bullet', sql`DELETE FROM catalog.course_bullets WHERE course_id = ${c}`],
          // 0005 quiz tables
          [
            'update quiz settings',
            sql`UPDATE catalog.lecture_quizzes SET pass_pct = 80 WHERE lecture_id = ${lectureId}`,
          ],
          [
            'delete quiz settings',
            sql`DELETE FROM catalog.lecture_quizzes WHERE lecture_id = ${lectureId}`,
          ],
          [
            'insert question',
            sql`INSERT INTO catalog.quiz_questions (lecture_id, position, kind, prompt_md) VALUES (${lectureId}, 1, 'SINGLE_CHOICE', 'Q')`,
          ],
          [
            'update question',
            sql`UPDATE catalog.quiz_questions SET prompt_md = 'Changed' WHERE id = ${questionId}`,
          ],
          ['delete question', sql`DELETE FROM catalog.quiz_questions WHERE id = ${questionId}`],
          [
            'insert option',
            sql`INSERT INTO catalog.quiz_options (question_id, position, text) VALUES (${questionId}, 2, 'Maybe')`,
          ],
          [
            'update option',
            sql`UPDATE catalog.quiz_options SET text = 'Yes!' WHERE question_id = ${questionId} AND position = 0`,
          ],
          [
            'delete option',
            sql`DELETE FROM catalog.quiz_options WHERE question_id = ${questionId}`,
          ],
        ];
        for (const [label, statement] of writes) {
          const err = await expectFailure(trx, () => statement.execute(trx));
          expect({ label, code: err.code, constraint: err.constraint }).toEqual({
            label,
            code: '23514',
            constraint: 'courses_working_copy_locked_ck',
          });
        }
      });
    });
  }
});
