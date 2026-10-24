import type { Executor } from '@udemy/db';
import { AnswerNotFound, QuestionNotFound } from '../domain/engagement.errors';
import { type AnswerRecord, canSeeAnswer, canSeeQuestion, type QuestionRecord } from '../domain/qa';
import type { AnswerWithQuestion, QaRepository } from './ports/qa.repository';

/**
 * Course-scoped Q&A lookups (design §9 IDOR): a question or answer of another course is the
 * same 404 as an unknown one, and so is content the viewer may not see (hidden content is
 * visible to its author only, a deleted question only as a placeholder while it has answers).
 */
export function questionInCourse(
  question: QuestionRecord | null,
  courseId: string,
  viewerId: string,
): QuestionRecord {
  if (question === null || question.courseId !== courseId || !canSeeQuestion(question, viewerId)) {
    throw new QuestionNotFound();
  }
  return question;
}

/** @throws QuestionNotFound */
export async function findVisibleQuestion(
  qa: QaRepository,
  courseId: string,
  questionId: string,
  viewerId: string,
  ex?: Executor,
): Promise<QuestionRecord> {
  return questionInCourse(await qa.findQuestion(questionId, ex), courseId, viewerId);
}

/** An answer the viewer can see, of a question of this course they can see. */
export function answerInCourse(
  found: AnswerWithQuestion | null,
  courseId: string,
  viewerId: string,
): AnswerWithQuestion {
  if (
    found === null ||
    found.question.courseId !== courseId ||
    !canSeeAnswer(found.answer, viewerId) ||
    !canSeeQuestion(found.question, viewerId)
  ) {
    throw new AnswerNotFound();
  }
  return found;
}

/** @throws AnswerNotFound */
export async function findVisibleAnswer(
  qa: QaRepository,
  courseId: string,
  answerId: string,
  viewerId: string,
  ex?: Executor,
): Promise<{ readonly answer: AnswerRecord; readonly question: QuestionRecord }> {
  return answerInCourse(await qa.findAnswer(answerId, ex), courseId, viewerId);
}
