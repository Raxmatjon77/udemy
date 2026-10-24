/**
 * Q&A reads and votes (docs/phase-5-schema-design.md §8.5, D12, races R7/R8).
 *
 * Counters (`upvote_count`, `answer_count`, `last_activity_at`) are trigger-maintained and exact
 * in the same statement; the app can never write them (questions_counters_ck /
 * answers_counters_ck). A vote is `INSERT ... ON CONFLICT DO NOTHING` (losers fire no trigger,
 * so 20 parallel votes by one user count once); votes by different users serialise on the
 * subject row in the delta UPDATE.
 *
 * Keyset cursors carry the exact SQL timestamp text (`::text`, microseconds), never a JS Date.
 */
import { sql } from 'kysely';
import { escapeLikePattern } from '../catalog/queries';
import { assertIntInRange, assertOneOf } from '../internal/assert';
import type { Executor } from '../transaction';

const MAX_PAGE_SIZE = 100;
/** `QA_LIMITS.searchMinChars`. */
export const QA_SEARCH_MIN_CHARS = 3;

export const QA_SORTS = ['recent', 'top', 'unanswered'] as const;
export type QaSort = (typeof QA_SORTS)[number];

export type QuestionCursor =
  | { sort: 'recent'; lastActivityAt: string; id: string }
  | { sort: 'top'; upvoteCount: number; id: string }
  | { sort: 'unanswered'; createdAt: string; id: string };

export interface QuestionListItem {
  id: string;
  courseId: string;
  lectureId: string | null;
  authorId: string;
  title: string;
  upvoteCount: number;
  answerCount: number;
  resolved: boolean;
  lastActivityAt: Date;
  createdAt: Date;
  /** Next-page cursor of this row for the requested sort. */
  cursor: QuestionCursor;
}

export interface ListQuestionsOptions {
  courseId: string;
  sort: QaSort;
  limit: number;
  /** Filter to one lecture (served by the lecture index for `recent`). */
  lectureId?: string;
  /** Course-scoped title search, >= 3 characters (trigram index). */
  titleContains?: string;
  after?: QuestionCursor;
}

/** ListQuestions: visible, non-deleted questions of a course, keyset per sort. */
export async function listQuestions(
  executor: Executor,
  options: ListQuestionsOptions,
): Promise<QuestionListItem[]> {
  assertOneOf('sort', options.sort, QA_SORTS);
  assertIntInRange('limit', options.limit, 1, MAX_PAGE_SIZE);
  if (options.after !== undefined && options.after.sort !== options.sort) {
    throw new RangeError('cursor sort does not match the requested sort');
  }
  const q = options.titleContains?.trim();
  if (q !== undefined && q.length < QA_SEARCH_MIN_CHARS) {
    throw new RangeError(`titleContains needs at least ${QA_SEARCH_MIN_CHARS} characters`);
  }
  const filters = [
    sql`course_id = ${options.courseId}`,
    sql`deleted_at IS NULL`,
    sql`moderation_status = 'VISIBLE'`,
  ];
  if (options.lectureId !== undefined) filters.push(sql`lecture_id = ${options.lectureId}`);
  if (q !== undefined) filters.push(sql`title ILIKE ${`%${escapeLikePattern(q)}%`}`);
  if (options.sort === 'unanswered') filters.push(sql`answer_count = 0`);
  const a = options.after;
  if (a?.sort === 'recent') {
    filters.push(sql`(last_activity_at, id) < (${a.lastActivityAt}::timestamptz, ${a.id}::uuid)`);
  } else if (a?.sort === 'top') {
    filters.push(sql`(upvote_count, id) < (${a.upvoteCount}::int, ${a.id}::uuid)`);
  } else if (a?.sort === 'unanswered') {
    filters.push(sql`(created_at, id) < (${a.createdAt}::timestamptz, ${a.id}::uuid)`);
  }
  const order =
    options.sort === 'recent'
      ? sql`last_activity_at DESC, id DESC`
      : options.sort === 'top'
        ? sql`upvote_count DESC, id DESC`
        : sql`created_at DESC, id DESC`;
  const { rows } = await sql<
    Omit<QuestionListItem, 'cursor'> & { lastActivityAtText: string; createdAtText: string }
  >`
    SELECT id, course_id, lecture_id, author_id, title, upvote_count, answer_count,
           accepted_answer_id IS NOT NULL AS resolved, last_activity_at, created_at,
           last_activity_at::text AS last_activity_at_text, created_at::text AS created_at_text
      FROM engagement.questions
     WHERE ${sql.join(filters, sql` AND `)}
     ORDER BY ${order}
     LIMIT ${options.limit}::int
  `.execute(executor);
  return rows.map(({ lastActivityAtText, createdAtText, ...r }) => ({
    ...r,
    cursor:
      options.sort === 'recent'
        ? { sort: 'recent', lastActivityAt: lastActivityAtText, id: r.id }
        : options.sort === 'top'
          ? { sort: 'top', upvoteCount: r.upvoteCount, id: r.id }
          : { sort: 'unanswered', createdAt: createdAtText, id: r.id },
  }));
}

export const VOTE_SUBJECTS = ['QUESTION', 'ANSWER'] as const;
export type VoteSubject = (typeof VOTE_SUBJECTS)[number];

const VOTE_TABLE: Readonly<Record<VoteSubject, string>> = Object.freeze({
  QUESTION: 'engagement.question_votes',
  ANSWER: 'engagement.answer_votes',
});

/**
 * Upvote (idempotent). true = this call added the vote. Own content -> 23514
 * `*_votes_own_content_ck`; unknown subject -> 23503 `*_votes_subject_id_fk`.
 */
export async function castVote(
  executor: Executor,
  input: { subject: VoteSubject; subjectId: string; userId: string },
): Promise<boolean> {
  assertOneOf('subject', input.subject, VOTE_SUBJECTS);
  const result = await sql`
    INSERT INTO ${sql.raw(VOTE_TABLE[input.subject])} (subject_id, user_id)
    VALUES (${input.subjectId}, ${input.userId})
    ON CONFLICT (subject_id, user_id) DO NOTHING
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/** Remove an upvote (idempotent). true = this call removed it. */
export async function retractVote(
  executor: Executor,
  input: { subject: VoteSubject; subjectId: string; userId: string },
): Promise<boolean> {
  assertOneOf('subject', input.subject, VOTE_SUBJECTS);
  const result = await sql`
    DELETE FROM ${sql.raw(VOTE_TABLE[input.subject])} WHERE subject_id = ${input.subjectId} AND user_id = ${input.userId}
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

/** The subset of `subjectIds` the user has upvoted ("my votes" on a page). */
export async function findMyVotes(
  executor: Executor,
  input: { subject: VoteSubject; subjectIds: readonly string[]; userId: string },
): Promise<string[]> {
  assertOneOf('subject', input.subject, VOTE_SUBJECTS);
  assertIntInRange('subjectIds.length', input.subjectIds.length, 0, 1000);
  if (input.subjectIds.length === 0) return [];
  const { rows } = await sql<{ subjectId: string }>`
    SELECT subject_id FROM ${sql.raw(VOTE_TABLE[input.subject])}
     WHERE subject_id = ANY(${[...input.subjectIds]}::uuid[]) AND user_id = ${input.userId}
  `.execute(executor);
  return rows.map((r) => r.subjectId);
}
