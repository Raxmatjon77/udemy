import { Injectable } from '@nestjs/common';
import { QUIZ_QUESTION_KINDS } from '@udemy/contracts';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type QuizOptionRecord,
  type QuizQuestionPatch,
  type QuizQuestionRecord,
  QuizRepository,
  type QuizSettingsRecord,
  type WorkingQuizRecord,
} from '../application/ports/quiz.repository';
import type { QuizOptionDraft } from '../domain/quiz';
import { mapCatalogConstraints } from './catalog-constraint-errors';
import { narrow } from './row-mapping';

const SETTINGS_COLUMNS = ['lectureId', 'passPct', 'updatedAt'] as const;
const QUESTION_COLUMNS = [
  'id',
  'lectureId',
  'position',
  'kind',
  'promptMd',
  'explanationMd',
  'updatedAt',
] as const;

interface QuestionRow {
  id: string;
  lectureId: string;
  position: number;
  kind: string;
  promptMd: string;
  explanationMd: string | null;
  updatedAt: Date;
}

interface OptionRow {
  questionId: string;
  position: number;
  text: string;
  isCorrect: boolean;
}

function toQuestion(row: QuestionRow, options: readonly QuizOptionRecord[]): QuizQuestionRecord {
  return {
    id: row.id,
    lectureId: row.lectureId,
    position: row.position,
    kind: narrow(QUIZ_QUESTION_KINDS, row.kind, 'catalog.quiz_questions.kind'),
    promptMd: row.promptMd,
    explanationMd: row.explanationMd,
    updatedAt: row.updatedAt,
    options,
  };
}

function groupOptions(rows: readonly OptionRow[]): Map<string, QuizOptionRecord[]> {
  const byQuestion = new Map<string, QuizOptionRecord[]>();
  for (const row of rows) {
    const list = byQuestion.get(row.questionId) ?? [];
    list.push({ position: row.position, text: row.text, isCorrect: row.isCorrect });
    byQuestion.set(row.questionId, list);
  }
  for (const list of byQuestion.values()) list.sort((a, b) => a.position - b.position);
  return byQuestion;
}

/**
 * The QUIZ working copy with Kysely (Phase 5 schema doc §1c–§1f). Every question lookup and
 * write is scoped by `lecture_id`; the course scope comes from the caller (lecture resolved
 * by course first). Positions are rewritten in single statements over the DEFERRED unique.
 */
@Injectable()
export class KyselyQuizRepository extends QuizRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findQuiz(lectureId: string, ex: Executor = this.db): Promise<WorkingQuizRecord | null> {
    const settings = await ex
      .selectFrom('catalog.lectureQuizzes')
      .select(SETTINGS_COLUMNS)
      .where('lectureId', '=', lectureId)
      .executeTakeFirst();
    if (settings === undefined) return null;
    const quizzes = await this.loadQuestions([settings], ex);
    return quizzes.get(lectureId) ?? null;
  }

  async listCourseQuizzes(
    courseId: string,
    ex: Executor = this.db,
  ): Promise<Map<string, WorkingQuizRecord>> {
    const settings = await ex
      .selectFrom('catalog.lectureQuizzes as q')
      .innerJoin('catalog.lectures as l', 'l.id', 'q.lectureId')
      .select(['q.lectureId', 'q.passPct', 'q.updatedAt'])
      .where('l.courseId', '=', courseId)
      .execute();
    return this.loadQuestions(settings, ex);
  }

  /** Questions and options of these quizzes: two queries whatever the count. */
  private async loadQuestions(
    settings: readonly QuizSettingsRecord[],
    ex: Executor,
  ): Promise<Map<string, WorkingQuizRecord>> {
    const result = new Map<string, WorkingQuizRecord>();
    if (settings.length === 0) return result;
    const lectureIds = settings.map((s) => s.lectureId);
    const questions = await ex
      .selectFrom('catalog.quizQuestions')
      .select(QUESTION_COLUMNS)
      .where('lectureId', 'in', lectureIds)
      .orderBy('lectureId')
      .orderBy('position')
      .execute();
    const options =
      questions.length === 0
        ? new Map<string, QuizOptionRecord[]>()
        : groupOptions(
            await ex
              .selectFrom('catalog.quizOptions')
              .select(['questionId', 'position', 'text', 'isCorrect'])
              .where(
                'questionId',
                'in',
                questions.map((q) => q.id),
              )
              .execute(),
          );
    for (const s of settings) {
      result.set(s.lectureId, {
        settings: { lectureId: s.lectureId, passPct: s.passPct, updatedAt: s.updatedAt },
        questions: questions
          .filter((q) => q.lectureId === s.lectureId)
          .map((q) => toQuestion(q, options.get(q.id) ?? [])),
      });
    }
    return result;
  }

  insertQuiz(trx: Transaction<DB>, lectureId: string): Promise<QuizSettingsRecord> {
    return mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.lectureQuizzes')
        .values({ lectureId })
        .returning(SETTINGS_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  }

  updatePassPct(
    trx: Transaction<DB>,
    lectureId: string,
    passPct: number,
  ): Promise<QuizSettingsRecord> {
    return mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.lectureQuizzes')
        .set({ passPct, updatedAt: sql<Date>`now()` })
        .where('lectureId', '=', lectureId)
        .returning(SETTINGS_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  }

  async touch(trx: Transaction<DB>, lectureId: string): Promise<void> {
    await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.lectureQuizzes')
        .set({ updatedAt: sql<Date>`now()` })
        .where('lectureId', '=', lectureId)
        .execute(),
    );
  }

  async listQuestionIds(trx: Transaction<DB>, lectureId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('catalog.quizQuestions')
      .select('id')
      .where('lectureId', '=', lectureId)
      .orderBy('position')
      .execute();
    return rows.map((r) => r.id);
  }

  async findQuestion(
    lectureId: string,
    questionId: string,
    ex: Executor = this.db,
  ): Promise<QuizQuestionRecord | null> {
    const row = await ex
      .selectFrom('catalog.quizQuestions')
      .select(QUESTION_COLUMNS)
      .where('id', '=', questionId)
      .where('lectureId', '=', lectureId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return toQuestion(row, await this.optionsOf(row.id, ex));
  }

  private async optionsOf(questionId: string, ex: Executor): Promise<QuizOptionRecord[]> {
    return ex
      .selectFrom('catalog.quizOptions')
      .select(['position', 'text', 'isCorrect'])
      .where('questionId', '=', questionId)
      .orderBy('position')
      .execute();
  }

  async insertQuestion(
    trx: Transaction<DB>,
    question: {
      readonly lectureId: string;
      readonly position: number;
      readonly kind: QuizQuestionRecord['kind'];
      readonly promptMd: string;
      readonly explanationMd: string | null;
    },
  ): Promise<QuizQuestionRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.quizQuestions')
        .values({ ...question })
        .returning(QUESTION_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toQuestion(row, []);
  }

  async updateQuestion(
    trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
    patch: QuizQuestionPatch,
  ): Promise<QuizQuestionRecord> {
    const row = await mapCatalogConstraints(() =>
      trx
        .updateTable('catalog.quizQuestions')
        .set({ ...patch, updatedAt: sql<Date>`now()` })
        .where('id', '=', questionId)
        .where('lectureId', '=', lectureId)
        .returning(QUESTION_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toQuestion(row, await this.optionsOf(row.id, trx));
  }

  async deleteQuestion(trx: Transaction<DB>, lectureId: string, questionId: string): Promise<void> {
    await mapCatalogConstraints(async () => {
      const deleted = await trx
        .deleteFrom('catalog.quizQuestions')
        .where('id', '=', questionId)
        .where('lectureId', '=', lectureId)
        .returning('id')
        .executeTakeFirst();
      if (deleted === undefined) return;
      await sql`
        UPDATE catalog.quiz_questions q SET position = r.rn - 1
          FROM (SELECT id, (row_number() OVER (ORDER BY position))::int AS rn
                  FROM catalog.quiz_questions WHERE lecture_id = ${lectureId}) r
         WHERE q.id = r.id AND q.position <> r.rn - 1
      `.execute(trx);
    });
  }

  async replaceOptions(
    trx: Transaction<DB>,
    lectureId: string,
    questionId: string,
    options: readonly QuizOptionDraft[],
  ): Promise<QuizQuestionRecord> {
    return mapCatalogConstraints(async () => {
      await trx.deleteFrom('catalog.quizOptions').where('questionId', '=', questionId).execute();
      if (options.length > 0) {
        await trx
          .insertInto('catalog.quizOptions')
          .values(
            options.map((option, position) => ({
              questionId,
              position,
              text: option.text,
              isCorrect: option.isCorrect,
            })),
          )
          .execute();
      }
      const row = await trx
        .updateTable('catalog.quizQuestions')
        .set({ updatedAt: sql<Date>`now()` })
        .where('id', '=', questionId)
        .where('lectureId', '=', lectureId)
        .returning(QUESTION_COLUMNS)
        .executeTakeFirstOrThrow();
      return toQuestion(row, await this.optionsOf(row.id, trx));
    });
  }

  async applyQuestionOrder(
    trx: Transaction<DB>,
    lectureId: string,
    positions: readonly { readonly id: string; readonly position: number }[],
  ): Promise<void> {
    if (positions.length === 0) return;
    await mapCatalogConstraints(async () => {
      await sql`
        UPDATE catalog.quiz_questions q SET position = v.position
          FROM unnest(${positions.map((p) => p.id)}::uuid[],
                      ${positions.map((p) => p.position)}::int[]) AS v(id, position)
         WHERE q.id = v.id AND q.lecture_id = ${lectureId} AND q.position <> v.position
      `.execute(trx);
    });
  }
}
