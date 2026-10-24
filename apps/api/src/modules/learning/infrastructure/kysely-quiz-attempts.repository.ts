import { Injectable } from '@nestjs/common';
import type { QuizAttemptStatus } from '@udemy/contracts';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type AttemptQuestionRecord,
  type AttemptSubmission,
  type NewQuizAttempt,
  type QuizAttemptKeyset,
  type QuizAttemptPageRow,
  type QuizAttemptRecord,
  QuizAttemptRepository,
} from '../application/ports/quiz-attempts.repository';
import { exactUtcText } from './row-mapping';

const ATTEMPT_COLUMNS = [
  'id',
  'userId',
  'courseId',
  'lectureId',
  'revisionId',
  'status',
  'passPct',
  'questionCount',
  'correctCount',
  'scorePct',
  'passed',
  'startedAt',
  'submittedAt',
  'abandonedAt',
] as const;

type AttemptRow = Omit<QuizAttemptRecord, 'status'> & { status: string };

function toRecord(row: AttemptRow): QuizAttemptRecord {
  return { ...row, status: row.status as QuizAttemptStatus };
}

/**
 * `learning.quiz_attempts`, `quiz_attempt_questions`, `quiz_attempt_selections` (schema doc §1,
 * races R2/R3). Every state change is conditional on `status = 'IN_PROGRESS'`; the questions are
 * inserted in the START transaction (`started_at` defaults to that transaction's `now()`);
 * timestamps are SQL `now()`, never JS Dates.
 */
@Injectable()
export class KyselyQuizAttemptRepository extends QuizAttemptRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async lockOpen(
    trx: Transaction<DB>,
    userId: string,
    lectureId: string,
  ): Promise<QuizAttemptRecord | null> {
    const row = await trx
      .selectFrom('learning.quizAttempts')
      .select(ATTEMPT_COLUMNS)
      .where('userId', '=', userId)
      .where('lectureId', '=', lectureId)
      .where('status', '=', 'IN_PROGRESS')
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async abandon(trx: Transaction<DB>, attemptId: string): Promise<boolean> {
    const result = await trx
      .updateTable('learning.quizAttempts')
      .set({ status: 'ABANDONED', abandonedAt: sql<Date>`now()` })
      .where('id', '=', attemptId)
      .where('status', '=', 'IN_PROGRESS')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async insert(trx: Transaction<DB>, attempt: NewQuizAttempt): Promise<QuizAttemptRecord | null> {
    // ON CONFLICT on the partial open-attempt index: a parallel start that committed first
    // makes this a no-op (no 23505 aborting the transaction); the caller re-reads the winner.
    const row = await trx
      .insertInto('learning.quizAttempts')
      .values({
        userId: attempt.userId,
        courseId: attempt.courseId,
        lectureId: attempt.lectureId,
        revisionId: attempt.revisionId,
        passPct: attempt.passPct,
        questionCount: attempt.questionIds.length,
      })
      .onConflict((oc) =>
        oc
          .columns(['userId', 'lectureId'])
          // A literal predicate: arbiter-index inference must prove it implies the partial
          // index's `WHERE status = 'IN_PROGRESS'` at plan time (a bound parameter cannot).
          .where(sql<boolean>`status = 'IN_PROGRESS'`)
          .doNothing(),
      )
      .returning(ATTEMPT_COLUMNS)
      .executeTakeFirst();
    if (row === undefined) return null;
    await trx
      .insertInto('learning.quizAttemptQuestions')
      .values(
        attempt.questionIds.map((questionId, position) => ({
          attemptId: row.id,
          questionId,
          position,
        })),
      )
      .execute();
    return toRecord(row);
  }

  async findOwn(
    userId: string,
    attemptId: string,
    options: { readonly ex?: Executor; readonly forUpdate?: boolean } = {},
  ): Promise<QuizAttemptRecord | null> {
    let query = (options.ex ?? this.db)
      .selectFrom('learning.quizAttempts')
      .select(ATTEMPT_COLUMNS)
      .where('id', '=', attemptId)
      .where('userId', '=', userId);
    if (options.forUpdate === true) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  listQuestions(attemptId: string, ex: Executor = this.db): Promise<AttemptQuestionRecord[]> {
    return ex
      .selectFrom('learning.quizAttemptQuestions')
      .select(['questionId', 'position', 'isCorrect'])
      .where('attemptId', '=', attemptId)
      .orderBy('position')
      .execute();
  }

  async listSelections(attemptId: string, ex: Executor = this.db): Promise<Map<string, number[]>> {
    const rows = await ex
      .selectFrom('learning.quizAttemptSelections')
      .select(['questionId', 'optionPosition'])
      .where('attemptId', '=', attemptId)
      .orderBy('questionId')
      .orderBy('optionPosition')
      .execute();
    const result = new Map<string, number[]>();
    for (const row of rows) {
      const list = result.get(row.questionId) ?? [];
      list.push(row.optionPosition);
      result.set(row.questionId, list);
    }
    return result;
  }

  async submit(
    trx: Transaction<DB>,
    submission: AttemptSubmission,
  ): Promise<QuizAttemptRecord | null> {
    const { attemptId } = submission;
    // 1. grades (only NULL -> value, while IN_PROGRESS: quiz_attempt_questions_guard)
    if (submission.graded.length > 0) {
      await sql`
        UPDATE learning.quiz_attempt_questions q
           SET is_correct = v.ok
          FROM unnest(${submission.graded.map((g) => g.questionId)}::uuid[],
                      ${submission.graded.map((g) => g.isCorrect)}::boolean[]) AS v(question_id, ok)
         WHERE q.attempt_id = ${attemptId} AND q.question_id = v.question_id
      `.execute(trx);
    }
    // 2. selections (append-only, only while IN_PROGRESS: quiz_attempt_selections_open_trg)
    const selections = [...submission.selections].flatMap(([questionId, positions]) =>
      positions.map((optionPosition) => ({ attemptId, questionId, optionPosition })),
    );
    if (selections.length > 0) {
      await trx.insertInto('learning.quizAttemptSelections').values(selections).execute();
    }
    // 3. the conditional transition; score_pct / passed are generated (the DB is the authority).
    //    quiz_attempts_grading_ck re-checks the counts at COMMIT.
    const row = await trx
      .updateTable('learning.quizAttempts')
      .set({
        status: 'SUBMITTED',
        correctCount: submission.correctCount,
        submittedAt: sql<Date>`now()`,
      })
      .where('id', '=', attemptId)
      .where('status', '=', 'IN_PROGRESS')
      .returning(ATTEMPT_COLUMNS)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async listPage(
    input: {
      readonly userId: string;
      readonly lectureId: string;
      readonly after: QuizAttemptKeyset | null;
      readonly limit: number;
    },
    ex: Executor = this.db,
  ): Promise<QuizAttemptPageRow[]> {
    // Served by quiz_attempts_user_id_lecture_id_started_at_id_idx.
    let query = ex
      .selectFrom('learning.quizAttempts')
      .select(ATTEMPT_COLUMNS)
      .select(exactUtcText('started_at').as('startedAtKey'))
      .where('userId', '=', input.userId)
      .where('lectureId', '=', input.lectureId);
    if (input.after !== null) {
      query = query.where(
        sql<boolean>`(started_at, id) < (${input.after.at}::timestamptz, ${input.after.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('startedAt', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(({ startedAtKey, ...attempt }) => ({
      attempt: toRecord(attempt),
      keyset: { at: startedAtKey, id: attempt.id },
    }));
  }

  async ownerOf(attemptId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('learning.quizAttempts')
      .select('userId')
      .where('id', '=', attemptId)
      .executeTakeFirst();
    return row?.userId ?? null;
  }
}
