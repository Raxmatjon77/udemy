import {
  QuizAuthoringSchema,
  QuizQuestionAuthoringSchema,
  type CreateQuizQuestionRequest,
  type PutQuizQuestionOptionsRequest,
  type QuizAuthoring,
  type QuizQuestionAuthoring,
  type UpdateQuizQuestionRequest,
} from '@udemy/contracts';

import { api } from './api';

/*
 * Quiz authoring of a QUIZ lecture's working copy (Phase 5 design D6, §8 "Quiz authoring";
 * contracts `http/quiz.ts`). Every write takes the course lock and bumps the course version like
 * the other curriculum writes; 409 `course_in_review` while a revision is pending.
 */

const enc = encodeURIComponent;
const quiz = (courseId: string, lectureId: string) =>
  `/courses/${enc(courseId)}/lectures/${enc(lectureId)}/quiz`;

export const quizKeys = {
  quiz: (courseId: string, lectureId: string) => ['course', courseId, 'quiz', lectureId] as const,
};

export const quizApi = {
  get: (courseId: string, lectureId: string): Promise<QuizAuthoring> =>
    api(quiz(courseId, lectureId), { schema: QuizAuthoringSchema }),
  setPassPct: (courseId: string, lectureId: string, passPct: number): Promise<QuizAuthoring> =>
    api(quiz(courseId, lectureId), {
      method: 'PUT',
      json: { passPct },
      schema: QuizAuthoringSchema,
    }),
  addQuestion: (
    courseId: string,
    lectureId: string,
    body: CreateQuizQuestionRequest,
  ): Promise<QuizQuestionAuthoring> =>
    api(`${quiz(courseId, lectureId)}/questions`, {
      method: 'POST',
      json: body,
      schema: QuizQuestionAuthoringSchema,
    }),
  updateQuestion: (
    courseId: string,
    lectureId: string,
    questionId: string,
    body: UpdateQuizQuestionRequest,
  ): Promise<QuizQuestionAuthoring> =>
    api(`${quiz(courseId, lectureId)}/questions/${enc(questionId)}`, {
      method: 'PATCH',
      json: body,
      schema: QuizQuestionAuthoringSchema,
    }),
  deleteQuestion: (courseId: string, lectureId: string, questionId: string): Promise<void> =>
    api(`${quiz(courseId, lectureId)}/questions/${enc(questionId)}`, { method: 'DELETE' }),
  putOptions: (
    courseId: string,
    lectureId: string,
    questionId: string,
    body: PutQuizQuestionOptionsRequest,
  ): Promise<QuizQuestionAuthoring> =>
    api(`${quiz(courseId, lectureId)}/questions/${enc(questionId)}/options`, {
      method: 'PUT',
      json: body,
      schema: QuizQuestionAuthoringSchema,
    }),
  reorder: (courseId: string, lectureId: string, questionIds: string[]): Promise<QuizAuthoring> =>
    api(`${quiz(courseId, lectureId)}/order`, {
      method: 'PUT',
      json: { questionIds },
      schema: QuizAuthoringSchema,
    }),
};
