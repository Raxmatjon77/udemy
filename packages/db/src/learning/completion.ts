/**
 * Lecture and course completion (docs/phase-5-schema-design.md §8.2, D4/D5, race R1).
 *
 * Every write takes the `lrnc` (user, course) mutex first, then reads in a NEW statement
 * (READ COMMITTED: the second of two parallel completions sees the first one's row), so
 * finishing the last two lectures in parallel yields exactly one course_completions row.
 * `lecture_completions_pk` / `course_completions_pk` with ON CONFLICT DO NOTHING RETURNING make
 * every step idempotent: only the inserter emits LectureCompleted / CourseCompleted.
 */
import { sql } from 'kysely';
import { assertIntInRange, assertOneOf } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';
import { lockLearningCompletion } from './locks';

export const LECTURE_TYPES = ['VIDEO', 'ARTICLE', 'RESOURCE', 'QUIZ'] as const;
export type LectureType = (typeof LECTURE_TYPES)[number];

/** `lecture_completions_cause_ck` (= contracts LECTURE_COMPLETION_CAUSES). */
export const LECTURE_COMPLETION_CAUSES = [
  'VIDEO_WATCHED',
  'ARTICLE_READ',
  'RESOURCE_OPENED',
  'QUIZ_PASSED',
  'MANUAL',
] as const;
export type LectureCompletionCause = (typeof LECTURE_COMPLETION_CAUSES)[number];

/** `lecture_completions_cause_type_ck` (= contracts LECTURE_COMPLETION_CAUSES_BY_TYPE). */
export const COMPLETION_CAUSES_BY_TYPE: Readonly<
  Record<LectureType, readonly LectureCompletionCause[]>
> = Object.freeze({
  VIDEO: ['VIDEO_WATCHED'],
  ARTICLE: ['ARTICLE_READ', 'MANUAL'],
  RESOURCE: ['RESOURCE_OPENED', 'MANUAL'],
  QUIZ: ['QUIZ_PASSED'],
});

/** 50 sections x 100 lectures (`course_completions_lecture_count_ck`). */
export const MAX_LIVE_LECTURES = 5000;

export interface LectureCompletionInput {
  userId: string;
  courseId: string;
  lectureId: string;
  lectureType: LectureType;
  cause: LectureCompletionCause;
  /** Live revision at completion. */
  revisionId: string;
  /** QUIZ_PASSED only: the passing, submitted attempt. */
  quizAttemptId?: string | null;
}

export interface LiveLectureSet {
  /** Live revision whose lecture set is evaluated. */
  revisionId: string;
  /** Every lecture id of the live revision (distinct). */
  liveLectureIds: readonly string[];
}

function assertCompletionInput(input: LectureCompletionInput): void {
  assertOneOf('lectureType', input.lectureType, LECTURE_TYPES);
  assertOneOf('cause', input.cause, LECTURE_COMPLETION_CAUSES);
  if (!COMPLETION_CAUSES_BY_TYPE[input.lectureType].includes(input.cause)) {
    throw new RangeError(`cause ${input.cause} is not allowed for a ${input.lectureType} lecture`);
  }
  if ((input.cause === 'QUIZ_PASSED') !== (input.quizAttemptId != null)) {
    throw new RangeError('quizAttemptId is required for QUIZ_PASSED and forbidden otherwise');
  }
}

function assertLiveSet(live: LiveLectureSet): string[] {
  const ids = [...new Set(live.liveLectureIds.map((id) => id.toLowerCase()))];
  assertIntInRange('liveLectureIds.length', ids.length, 1, MAX_LIVE_LECTURES);
  return ids;
}

/**
 * Inserts the completion (caller holds the lrnc lock). Returns `completedAt` when this call
 * created it (-> outbox LectureCompleted), null when it already existed.
 */
export async function insertLectureCompletion(
  executor: Executor,
  input: LectureCompletionInput,
): Promise<{ completedAt: Date } | null> {
  assertCompletionInput(input);
  const trx = requireTransaction(executor, 'insertLectureCompletion');
  const { rows } = await sql<{ completedAt: Date }>`
    INSERT INTO learning.lecture_completions (user_id, lecture_id, course_id, lecture_type, cause, revision_id, quiz_attempt_id)
    VALUES (${input.userId}, ${input.lectureId}, ${input.courseId}, ${input.lectureType}, ${input.cause},
            ${input.revisionId}, ${input.quizAttemptId ?? null})
    ON CONFLICT (user_id, lecture_id) DO NOTHING
    RETURNING completed_at
  `.execute(trx);
  return rows[0] ?? null;
}

export interface CourseCompletionState {
  completedLectures: number;
  totalLectures: number;
  /** Set when the course is complete; `newlyCompleted` = this call inserted it (-> CourseCompleted). */
  completion: { completedAt: Date; newlyCompleted: boolean } | null;
}

/**
 * EvaluateCourseCompletion (caller holds the lrnc lock; a new statement after the lecture
 * insert): when the user's completions cover the whole live lecture set, records the permanent
 * course completion. Never undone (D5).
 */
export async function evaluateCourseCompletion(
  executor: Executor,
  input: { userId: string; courseId: string } & LiveLectureSet,
): Promise<CourseCompletionState> {
  const ids = assertLiveSet(input);
  const trx = requireTransaction(executor, 'evaluateCourseCompletion');
  const { rows } = await sql<{ done: number }>`
    SELECT count(*)::int AS done
      FROM learning.lecture_completions
     WHERE user_id = ${input.userId} AND lecture_id = ANY(${ids}::uuid[])
  `.execute(trx);
  const done = rows[0]?.done ?? 0;
  const state: CourseCompletionState = {
    completedLectures: done,
    totalLectures: ids.length,
    completion: null,
  };
  if (done < ids.length) {
    // Not (yet) complete for the live set; an earlier completion still stands (permanent).
    const prior = await sql<{ completedAt: Date }>`
      SELECT completed_at FROM learning.course_completions WHERE user_id = ${input.userId} AND course_id = ${input.courseId}
    `.execute(trx);
    const at = prior.rows[0]?.completedAt;
    if (at !== undefined) state.completion = { completedAt: at, newlyCompleted: false };
    return state;
  }
  const inserted = await sql<{ completedAt: Date }>`
    INSERT INTO learning.course_completions (user_id, course_id, revision_id, lecture_count)
    VALUES (${input.userId}, ${input.courseId}, ${input.revisionId}, ${ids.length})
    ON CONFLICT (user_id, course_id) DO NOTHING
    RETURNING completed_at
  `.execute(trx);
  const first = inserted.rows[0];
  if (first !== undefined) {
    state.completion = { completedAt: first.completedAt, newlyCompleted: true };
    return state;
  }
  const existing = await sql<{ completedAt: Date }>`
    SELECT completed_at FROM learning.course_completions WHERE user_id = ${input.userId} AND course_id = ${input.courseId}
  `.execute(trx);
  state.completion = { completedAt: existing.rows[0]!.completedAt, newlyCompleted: false };
  return state;
}

export interface RecordCompletionResult {
  /** Set when this call completed the lecture (-> LectureCompleted). */
  lecture: { completedAt: Date } | null;
  course: CourseCompletionState;
}

/** lrnc lock -> lecture insert -> course evaluation, in the caller's transaction (R1). */
export async function recordLectureCompletion(
  executor: Executor,
  input: LectureCompletionInput & { liveLectureIds: readonly string[] },
): Promise<RecordCompletionResult> {
  assertCompletionInput(input);
  assertLiveSet(input);
  const trx = requireTransaction(executor, 'recordLectureCompletion');
  await lockLearningCompletion(trx, input.userId, input.courseId);
  const lecture = await insertLectureCompletion(trx, input);
  const course = await evaluateCourseCompletion(trx, {
    userId: input.userId,
    courseId: input.courseId,
    revisionId: input.revisionId,
    liveLectureIds: input.liveLectureIds,
  });
  return { lecture, course };
}

/**
 * Un-complete (manual untick, ARTICLE/RESOURCE): lrnc lock, then DELETE. Returns the removed
 * row's type and cause (-> LectureCompletionCleared), null if it was not completed. Never
 * touches course_completions or certificates (P5-D3).
 */
export async function clearLectureCompletion(
  executor: Executor,
  input: { userId: string; courseId: string; lectureId: string },
): Promise<{ lectureType: LectureType; cause: LectureCompletionCause } | null> {
  const trx = requireTransaction(executor, 'clearLectureCompletion');
  await lockLearningCompletion(trx, input.userId, input.courseId);
  const { rows } = await sql<{ lectureType: LectureType; cause: LectureCompletionCause }>`
    DELETE FROM learning.lecture_completions
     WHERE user_id = ${input.userId} AND lecture_id = ${input.lectureId} AND course_id = ${input.courseId}
    RETURNING lecture_type, cause
  `.execute(trx);
  return rows[0] ?? null;
}

/** Completed lecture ids of (user, course), index-only (lecture_completions_user_id_course_id_idx). */
export async function listCompletedLectureIds(
  executor: Executor,
  userId: string,
  courseId: string,
): Promise<string[]> {
  const { rows } = await sql<{ lectureId: string }>`
    SELECT lecture_id FROM learning.lecture_completions
     WHERE user_id = ${userId} AND course_id = ${courseId}
     ORDER BY lecture_id
  `.execute(executor);
  return rows.map((r) => r.lectureId);
}

export interface CourseProgressCount {
  completed: number;
  total: number;
}

/**
 * `getPercents` for many courses in one GROUP BY: live lecture ids per course (flattened to
 * parallel arrays) joined to lecture_completions by PK. Courses without lectures are absent
 * from the input and report `{ completed: 0, total: 0 }`.
 */
export async function getCourseProgressCounts(
  executor: Executor,
  userId: string,
  courses: readonly { courseId: string; lectureIds: readonly string[] }[],
): Promise<Map<string, CourseProgressCount>> {
  assertIntInRange('courses.length', courses.length, 0, 1000);
  const result = new Map<string, CourseProgressCount>();
  const courseIds: string[] = [];
  const lectureIds: string[] = [];
  for (const c of courses) {
    result.set(c.courseId, { completed: 0, total: 0 });
    for (const l of new Set(c.lectureIds)) {
      courseIds.push(c.courseId);
      lectureIds.push(l);
    }
  }
  assertIntInRange('lectureIds.length', lectureIds.length, 0, 100_000);
  if (lectureIds.length === 0) return result;
  const { rows } = await sql<{ courseId: string; total: number; completed: number }>`
    SELECT l.course_id, count(*)::int AS total, count(c.lecture_id)::int AS completed
      FROM unnest(${courseIds}::uuid[], ${lectureIds}::uuid[]) AS l(course_id, lecture_id)
      LEFT JOIN learning.lecture_completions c ON c.user_id = ${userId} AND c.lecture_id = l.lecture_id
     GROUP BY l.course_id
  `.execute(executor);
  const byLower = new Map(courses.map((c) => [c.courseId.toLowerCase(), c.courseId]));
  for (const r of rows) {
    const id = byLower.get(r.courseId.toLowerCase()) ?? r.courseId;
    result.set(id, { completed: r.completed, total: r.total });
  }
  return result;
}
