import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { grantEnrollment } from '../enrollment/enrollments';
import type { Executor } from '../transaction';
import { uniqueSuffix } from './fixtures';

/**
 * Test-data builders for the Phase 5 integration tests (learning / engagement / notifications,
 * catalog QUIZ). Raw SQL, legal shapes: tests then break exactly one invariant. Soft references
 * (course / lecture / revision ids outside the catalog tests) are random uuids.
 */

export async function createQuestion(
  ex: Executor,
  opts: { authorId: string; courseId?: string; lectureId?: string | null; title?: string },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO engagement.questions (course_id, lecture_id, author_id, title, body_md)
    VALUES (${opts.courseId ?? randomUUID()}, ${opts.lectureId ?? null}, ${opts.authorId},
            ${opts.title ?? `IT question ${uniqueSuffix()}`}, 'Question body')
    RETURNING id
  `.execute(ex);
  return rows[0]!.id;
}

export async function createAnswer(
  ex: Executor,
  opts: { questionId: string; authorId: string; body?: string },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO engagement.answers (question_id, author_id, body_md)
    VALUES (${opts.questionId}, ${opts.authorId}, ${opts.body ?? 'Answer body'})
    RETURNING id
  `.execute(ex);
  return rows[0]!.id;
}

export async function createReviewRow(
  ex: Executor,
  opts: { courseId: string; userId: string; rating: number; body?: string | null },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO engagement.reviews (course_id, user_id, rating, body)
    VALUES (${opts.courseId}, ${opts.userId}, ${opts.rating}, ${opts.body ?? null})
    RETURNING id
  `.execute(ex);
  return rows[0]!.id;
}

/** An ACTIVE FREE enrollment through grantEnrollment (row + GRANT transition). Needs a transaction. */
export async function createActiveEnrollment(
  ex: Executor,
  opts: { userId: string; courseId: string },
): Promise<string> {
  const r = await grantEnrollment(ex, {
    userId: opts.userId,
    courseId: opts.courseId,
    source: 'FREE',
  });
  return r.enrollmentId;
}

/** A permanent course completion (the FK target of certificates). */
export async function createCourseCompletion(
  ex: Executor,
  opts: { userId: string; courseId: string; revisionId?: string; lectureCount?: number },
): Promise<void> {
  await sql`
    INSERT INTO learning.course_completions (user_id, course_id, revision_id, lecture_count)
    VALUES (${opts.userId}, ${opts.courseId}, ${opts.revisionId ?? randomUUID()}, ${opts.lectureCount ?? 1})
  `.execute(ex);
}

/** A random valid certificate public code (26 Crockford base32 characters). */
export function certificateCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export interface QuizQuestionSpec {
  kind?: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE';
  /** Option correctness by position (positions 0..n-1 unless `positions` overrides them). */
  correct: boolean[];
  positions?: number[];
}

/**
 * A QUIZ revision lecture with its snapshot questions and options, inserted into an existing
 * revision of the SAME transaction (revision_quiz_*_same_tx_ck). Returns the lecture and
 * question ids. The deferred key/complete checks run at COMMIT.
 */
export async function insertQuizRevisionLecture(
  ex: Executor,
  opts: {
    revisionId: string;
    sectionId: string;
    position: number;
    passPct?: number;
    questions: QuizQuestionSpec[];
  },
): Promise<{ lectureId: string; questionIds: string[] }> {
  const lectureId = randomUUID();
  await sql`
    INSERT INTO catalog.revision_lectures (revision_id, lecture_id, section_id, position, type, title, is_preview, quiz_pass_pct)
    VALUES (${opts.revisionId}, ${lectureId}, ${opts.sectionId}, ${opts.position}, 'QUIZ', 'Quiz', false, ${opts.passPct ?? 70})
  `.execute(ex);
  const questionIds: string[] = [];
  for (const [qi, q] of opts.questions.entries()) {
    const questionId = randomUUID();
    questionIds.push(questionId);
    await sql`
      INSERT INTO catalog.revision_quiz_questions (revision_id, lecture_id, question_id, position, kind, prompt_md)
      VALUES (${opts.revisionId}, ${lectureId}, ${questionId}, ${qi}, ${q.kind ?? 'SINGLE_CHOICE'}, ${`Prompt ${qi}`})
    `.execute(ex);
    for (const [oi, isCorrect] of q.correct.entries()) {
      await sql`
        INSERT INTO catalog.revision_quiz_options (revision_id, question_id, position, text, is_correct)
        VALUES (${opts.revisionId}, ${questionId}, ${q.positions?.[oi] ?? oi}, ${`Option ${oi}`}, ${isCorrect})
      `.execute(ex);
    }
  }
  return { lectureId, questionIds };
}

/**
 * StartQuizAttempt shape: the attempt and its frozen questions in ONE transaction (the
 * quiz_attempt_questions_same_tx_ck needs started_at = now()). Returns the attempt id.
 */
export async function startQuizAttempt(
  ex: Executor,
  opts: {
    userId: string;
    courseId?: string;
    lectureId?: string;
    revisionId?: string;
    passPct?: number;
    questionIds: string[];
  },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO learning.quiz_attempts (user_id, course_id, lecture_id, revision_id, pass_pct, question_count)
    VALUES (${opts.userId}, ${opts.courseId ?? randomUUID()}, ${opts.lectureId ?? randomUUID()},
            ${opts.revisionId ?? randomUUID()}, ${opts.passPct ?? 70}, ${opts.questionIds.length})
    RETURNING id
  `.execute(ex);
  const id = rows[0]!.id;
  for (const [position, questionId] of opts.questionIds.entries()) {
    await sql`
      INSERT INTO learning.quiz_attempt_questions (attempt_id, question_id, position)
      VALUES (${id}, ${questionId}, ${position})
    `.execute(ex);
  }
  return id;
}

/** SubmitQuizAttempt shape: grade each question, then SUBMITTED with the matching correct_count. */
export async function submitQuizAttempt(
  ex: Executor,
  attemptId: string,
  results: boolean[],
): Promise<void> {
  const { rows } = await sql<{ questionId: string }>`
    SELECT question_id FROM learning.quiz_attempt_questions WHERE attempt_id = ${attemptId} ORDER BY position
  `.execute(ex);
  for (const [i, r] of rows.entries()) {
    await sql`
      UPDATE learning.quiz_attempt_questions SET is_correct = ${results[i] ?? false}
       WHERE attempt_id = ${attemptId} AND question_id = ${r.questionId}
    `.execute(ex);
  }
  await sql`
    UPDATE learning.quiz_attempts
       SET status = 'SUBMITTED', submitted_at = now(), correct_count = ${results.filter(Boolean).length}
     WHERE id = ${attemptId} AND status = 'IN_PROGRESS'
  `.execute(ex);
}
