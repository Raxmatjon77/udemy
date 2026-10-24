import { Injectable } from '@nestjs/common';
import {
  castVote,
  type DB,
  type Executor,
  findMyVotes,
  type ListQuestionsOptions,
  listQuestions,
  retractVote,
  sql,
  type Transaction,
  type VoteSubject,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type AcceptedAnswerChange,
  type AnswerWithQuestion,
  type CreatedAtKeyset,
  type CreatedAtRow,
  type InboxOptions,
  QaRepository,
  type QuestionListOptions,
  type QuestionListRow,
} from '../application/ports/qa.repository';
import type { AnswerRecord, QuestionRecord } from '../domain/qa';
import { mapEngagementConstraints } from './engagement-constraint-errors';
import {
  ANSWER_COLUMNS,
  type AnswerRow,
  QUESTION_COLUMNS,
  type QuestionRow,
  toAnswerRecord,
  toQuestionRecord,
} from './qa-row-mapping';

/** Exact UTC text of a timestamptz expression (keyset cursors keep the microseconds). */
const exactText = (column: string) =>
  sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/**
 * Q&A through Kysely and the `@udemy/db` operational SQL (`listQuestions`, `castVote`,
 * `retractVote`, `findMyVotes`). Counters are never written here: the triggers keep them exact
 * in the same statement, and the app could not write them anyway (`questions_counters_ck`).
 * Every statement maps its constraint violations to domain errors (schema doc §9).
 */
@Injectable()
export class KyselyQaRepository extends QaRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async listQuestions(options: QuestionListOptions): Promise<QuestionListRow[]> {
    const dbOptions: ListQuestionsOptions = {
      courseId: options.courseId,
      sort: options.sort,
      limit: options.limit,
      ...(options.lectureId === undefined ? {} : { lectureId: options.lectureId }),
      ...(options.titleContains === undefined ? {} : { titleContains: options.titleContains }),
      ...(options.after === null ? {} : { after: options.after }),
    };
    const items = await listQuestions(this.db, dbOptions);
    if (items.length === 0) return [];
    // the keyset read returns the list columns; the page is hydrated by primary key
    const { rows } = await sql<QuestionRow>`
      SELECT ${QUESTION_COLUMNS} FROM engagement.questions
       WHERE id = ANY(${items.map((i) => i.id)}::uuid[])
    `.execute(this.db);
    const byId = new Map(rows.map((r) => [r.id, toQuestionRecord(r)]));
    return items.flatMap((item): QuestionListRow[] => {
      const question = byId.get(item.id);
      return question === undefined ? [] : [{ question, cursor: item.cursor }];
    });
  }

  async findQuestion(questionId: string, ex?: Executor): Promise<QuestionRecord | null> {
    const { rows } = await sql<QuestionRow>`
      SELECT ${QUESTION_COLUMNS} FROM engagement.questions WHERE id = ${questionId}
    `.execute(ex ?? this.db);
    return rows[0] === undefined ? null : toQuestionRecord(rows[0]);
  }

  async lockQuestion(trx: Transaction<DB>, questionId: string): Promise<QuestionRecord | null> {
    const { rows } = await sql<QuestionRow>`
      SELECT ${QUESTION_COLUMNS} FROM engagement.questions WHERE id = ${questionId}
         FOR NO KEY UPDATE
    `.execute(trx);
    return rows[0] === undefined ? null : toQuestionRecord(rows[0]);
  }

  async insertQuestion(
    trx: Transaction<DB>,
    input: {
      courseId: string;
      lectureId: string | null;
      authorId: string;
      title: string;
      bodyMd: string;
    },
  ): Promise<QuestionRecord> {
    const { rows } = await mapEngagementConstraints(() =>
      sql<QuestionRow>`
        INSERT INTO engagement.questions (course_id, lecture_id, author_id, title, body_md)
        VALUES (${input.courseId}, ${input.lectureId}, ${input.authorId}, ${input.title}, ${input.bodyMd})
        RETURNING ${QUESTION_COLUMNS}
      `.execute(trx),
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT … RETURNING returned no question');
    return toQuestionRecord(row);
  }

  async updateQuestion(
    trx: Transaction<DB>,
    questionId: string,
    changes: { title?: string | undefined; bodyMd?: string | undefined },
  ): Promise<QuestionRecord | null> {
    const title = changes.title ?? null;
    const bodyMd = changes.bodyMd ?? null;
    const { rows } = await mapEngagementConstraints(() =>
      sql<QuestionRow>`
        UPDATE engagement.questions
           SET title = coalesce(${title}::text, title),
               body_md = coalesce(${bodyMd}::text, body_md),
               edited_at = CASE
                 WHEN (coalesce(${title}::text, title), coalesce(${bodyMd}::text, body_md))
                      IS DISTINCT FROM (title, body_md) THEN now()
                 ELSE edited_at END
         WHERE id = ${questionId} AND deleted_at IS NULL
        RETURNING ${QUESTION_COLUMNS}
      `.execute(trx),
    );
    return rows[0] === undefined ? null : toQuestionRecord(rows[0]);
  }

  async softDeleteQuestion(
    trx: Transaction<DB>,
    questionId: string,
  ): Promise<QuestionRecord | null> {
    const { rows } = await mapEngagementConstraints(() =>
      sql<QuestionRow>`
        UPDATE engagement.questions SET deleted_at = now()
         WHERE id = ${questionId} AND deleted_at IS NULL
        RETURNING ${QUESTION_COLUMNS}
      `.execute(trx),
    );
    return rows[0] === undefined ? null : toQuestionRecord(rows[0]);
  }

  async setAcceptedAnswer(
    trx: Transaction<DB>,
    questionId: string,
    answerId: string | null,
  ): Promise<AcceptedAnswerChange | null> {
    // PG 18 RETURNING old.*: the accepted answer before this statement (V8)
    const { rows } = await mapEngagementConstraints(() =>
      sql<QuestionRow & { previousAnswerId: string | null; at: Date }>`
        UPDATE engagement.questions SET accepted_answer_id = ${answerId}::uuid
         WHERE id = ${questionId} AND deleted_at IS NULL
        RETURNING ${QUESTION_COLUMNS}, old.accepted_answer_id AS previous_answer_id, now() AS at
      `.execute(trx),
    );
    const row = rows[0];
    if (row === undefined) return null;
    const { previousAnswerId, at, ...question } = row;
    return { question: toQuestionRecord(question), previousAnswerId, at };
  }

  async listAnswers(
    questionId: string,
    viewerId: string,
    after: CreatedAtKeyset | null,
    limit: number,
  ): Promise<CreatedAtRow<AnswerRecord>[]> {
    // answers_question_id_created_at_id_idx; oldest first
    const keyset =
      after === null
        ? sql`TRUE`
        : sql`(created_at, id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
    const { rows } = await sql<AnswerRow & { createdAtKey: string }>`
      SELECT ${ANSWER_COLUMNS}, ${exactText('created_at')} AS created_at_key
        FROM engagement.answers
       WHERE question_id = ${questionId} AND deleted_at IS NULL
         AND (moderation_status = 'VISIBLE' OR author_id = ${viewerId})
         AND ${keyset}
       ORDER BY created_at, id
       LIMIT ${limit}::int
    `.execute(this.db);
    return rows.map(({ createdAtKey, ...row }) => ({
      record: toAnswerRecord(row),
      createdAtKey,
    }));
  }

  async findAnswer(answerId: string, ex?: Executor): Promise<AnswerWithQuestion | null> {
    const { rows } = await sql<AnswerRow>`
      SELECT ${ANSWER_COLUMNS} FROM engagement.answers WHERE id = ${answerId}
    `.execute(ex ?? this.db);
    const answer = rows[0];
    if (answer === undefined) return null;
    const question = await this.findQuestion(answer.questionId, ex);
    if (question === null) throw new Error(`answer ${answerId} has no question (FK)`);
    return { answer: toAnswerRecord(answer), question };
  }

  async lockAnswerAcceptance(
    trx: Transaction<DB>,
    answerId: string,
  ): Promise<{ readonly wasAccepted: boolean } | null> {
    const answer = await sql<{ questionId: string }>`
      SELECT question_id FROM engagement.answers WHERE id = ${answerId} FOR NO KEY UPDATE
    `.execute(trx);
    const questionId = answer.rows[0]?.questionId;
    if (questionId === undefined) return null;
    // a new statement after the answer lock: sees an acceptance committed while we waited
    const question = await sql<{ acceptedAnswerId: string | null }>`
      SELECT accepted_answer_id FROM engagement.questions WHERE id = ${questionId} FOR NO KEY UPDATE
    `.execute(trx);
    return { wasAccepted: question.rows[0]?.acceptedAnswerId === answerId };
  }

  async insertAnswer(
    trx: Transaction<DB>,
    input: { questionId: string; authorId: string; bodyMd: string },
  ): Promise<AnswerRecord> {
    const { rows } = await mapEngagementConstraints(() =>
      sql<AnswerRow>`
        INSERT INTO engagement.answers (question_id, author_id, body_md)
        VALUES (${input.questionId}, ${input.authorId}, ${input.bodyMd})
        RETURNING ${ANSWER_COLUMNS}
      `.execute(trx),
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT … RETURNING returned no answer');
    return toAnswerRecord(row);
  }

  async updateAnswer(
    trx: Transaction<DB>,
    answerId: string,
    bodyMd: string,
  ): Promise<AnswerRecord | null> {
    const { rows } = await mapEngagementConstraints(() =>
      sql<AnswerRow>`
        UPDATE engagement.answers
           SET body_md = ${bodyMd},
               edited_at = CASE WHEN body_md IS DISTINCT FROM ${bodyMd}::text THEN now()
                                ELSE edited_at END
         WHERE id = ${answerId} AND deleted_at IS NULL
        RETURNING ${ANSWER_COLUMNS}
      `.execute(trx),
    );
    return rows[0] === undefined ? null : toAnswerRecord(rows[0]);
  }

  async softDeleteAnswer(trx: Transaction<DB>, answerId: string): Promise<AnswerRecord | null> {
    const { rows } = await mapEngagementConstraints(() =>
      sql<AnswerRow>`
        UPDATE engagement.answers SET deleted_at = now()
         WHERE id = ${answerId} AND deleted_at IS NULL
        RETURNING ${ANSWER_COLUMNS}
      `.execute(trx),
    );
    return rows[0] === undefined ? null : toAnswerRecord(rows[0]);
  }

  castVote(subject: VoteSubject, subjectId: string, userId: string): Promise<boolean> {
    return mapEngagementConstraints(() => castVote(this.db, { subject, subjectId, userId }));
  }

  retractVote(subject: VoteSubject, subjectId: string, userId: string): Promise<boolean> {
    return mapEngagementConstraints(() => retractVote(this.db, { subject, subjectId, userId }));
  }

  async votedAmong(
    subject: VoteSubject,
    subjectIds: readonly string[],
    userId: string,
  ): Promise<ReadonlySet<string>> {
    if (subjectIds.length === 0) return new Set();
    return new Set(await findMyVotes(this.db, { subject, subjectIds, userId }));
  }

  async listInbox(options: InboxOptions): Promise<CreatedAtRow<QuestionRecord>[]> {
    if (options.courseIds.length === 0) return [];
    // unanswered: questions_course_id_created_at_id_unanswered_idx (course_id = ANY(<= 100))
    const status =
      options.status === 'unanswered'
        ? sql`AND answer_count = 0`
        : options.status === 'unresolved'
          ? sql`AND accepted_answer_id IS NULL`
          : sql``;
    const keyset =
      options.after === null
        ? sql``
        : sql`AND (created_at, id) < (${options.after.createdAt}::timestamptz, ${options.after.id}::uuid)`;
    const { rows } = await sql<QuestionRow & { createdAtKey: string }>`
      SELECT ${QUESTION_COLUMNS}, ${exactText('created_at')} AS created_at_key
        FROM engagement.questions
       WHERE course_id = ANY(${[...options.courseIds]}::uuid[])
         AND deleted_at IS NULL AND moderation_status = 'VISIBLE'
         ${status} ${keyset}
       ORDER BY created_at DESC, id DESC
       LIMIT ${options.limit}::int
    `.execute(this.db);
    return rows.map(({ createdAtKey, ...row }) => ({
      record: toQuestionRecord(row),
      createdAtKey,
    }));
  }
}
