import {
  AnnouncementSchema,
  AnswerPageSchema,
  AnswerSchema,
  InstructorAnnouncementPageSchema,
  InstructorQaPageSchema,
  InstructorReviewPageSchema,
  QuestionDetailSchema,
  QuestionSchema,
  ReviewReplySchema,
  type Announcement,
  type Answer,
  type AnswerPage,
  type InstructorAnnouncementPage,
  type InstructorQaPage,
  type InstructorQaStatus,
  type InstructorReviewPage,
  type PostAnnouncementRequest,
  type Question,
  type QuestionDetail,
  type ReviewReply,
} from '@udemy/contracts';

import { api, queryString } from './api';

/*
 * Student engagement on the instructor's courses (Phase 5 design §8 "Q&A" and "Instructor"):
 * the Q&A inbox and threads, reviews with replies, and announcements. Paths are relative to
 * `/api/proxy`; every response is validated with its contracts schema.
 */

const enc = encodeURIComponent;
const course = (courseId: string) => `/courses/${enc(courseId)}`;
const PAGE_SIZE = 20;

/**
 * Query keys. Q&A lives under `['qa', …]`: the realtime client (`@udemy/web-realtime`) invalidates
 * `['qa', courseId]` on `qa.changed`, which covers a course's threads.
 */
export const engagementKeys = {
  qaAll: ['qa'] as const,
  qaInbox: (courseId: string | undefined, status: InstructorQaStatus) =>
    ['qa', 'inbox', { courseId: courseId ?? null, status }] as const,
  question: (courseId: string, questionId: string) =>
    ['qa', courseId, 'question', questionId] as const,
  answers: (courseId: string, questionId: string) =>
    ['qa', courseId, 'question', questionId, 'answers'] as const,
  reviews: (courseId: string, rating: number | undefined) =>
    ['course', courseId, 'reviews', { rating: rating ?? null }] as const,
  reviewsAll: (courseId: string) => ['course', courseId, 'reviews'] as const,
  announcements: (courseId: string) => ['course', courseId, 'announcements'] as const,
};

export const engagementApi = {
  /* ---- Q&A ---- */
  inbox: (params: {
    courseId: string | undefined;
    status: InstructorQaStatus;
    cursor: string | null;
  }): Promise<InstructorQaPage> =>
    api(
      `/instructor/qa${queryString({
        courseId: params.courseId,
        status: params.status,
        cursor: params.cursor,
        limit: PAGE_SIZE,
      })}`,
      { schema: InstructorQaPageSchema },
    ),
  question: (courseId: string, questionId: string): Promise<QuestionDetail> =>
    api(`${course(courseId)}/questions/${enc(questionId)}`, { schema: QuestionDetailSchema }),
  answers: (courseId: string, questionId: string, cursor: string | null): Promise<AnswerPage> =>
    api(
      `${course(courseId)}/questions/${enc(questionId)}/answers${queryString({
        cursor,
        limit: PAGE_SIZE,
      })}`,
      { schema: AnswerPageSchema },
    ),
  postAnswer: (courseId: string, questionId: string, bodyMd: string): Promise<Answer> =>
    api(`${course(courseId)}/questions/${enc(questionId)}/answers`, {
      method: 'POST',
      json: { bodyMd },
      schema: AnswerSchema,
    }),
  accept: (courseId: string, questionId: string, answerId: string): Promise<Question> =>
    api(`${course(courseId)}/questions/${enc(questionId)}/accepted-answer`, {
      method: 'PUT',
      json: { answerId },
      schema: QuestionSchema,
    }),
  unaccept: (courseId: string, questionId: string): Promise<Question> =>
    api(`${course(courseId)}/questions/${enc(questionId)}/accepted-answer`, {
      method: 'DELETE',
      schema: QuestionSchema,
    }),

  /* ---- reviews ---- */
  reviews: (
    courseId: string,
    params: { rating: number | undefined; cursor: string | null },
  ): Promise<InstructorReviewPage> =>
    api(
      `${course(courseId)}/reviews${queryString({
        rating: params.rating,
        cursor: params.cursor,
        limit: PAGE_SIZE,
      })}`,
      { schema: InstructorReviewPageSchema },
    ),
  reply: (courseId: string, reviewId: string, body: string): Promise<ReviewReply> =>
    api(`${course(courseId)}/reviews/${enc(reviewId)}/reply`, {
      method: 'PUT',
      json: { body },
      schema: ReviewReplySchema,
    }),
  deleteReply: (courseId: string, reviewId: string): Promise<void> =>
    api(`${course(courseId)}/reviews/${enc(reviewId)}/reply`, { method: 'DELETE' }),

  /* ---- announcements ---- */
  announcements: (courseId: string, cursor: string | null): Promise<InstructorAnnouncementPage> =>
    api(`${course(courseId)}/announcements${queryString({ cursor, limit: PAGE_SIZE })}`, {
      schema: InstructorAnnouncementPageSchema,
    }),
  postAnnouncement: (courseId: string, body: PostAnnouncementRequest): Promise<Announcement> =>
    api(`${course(courseId)}/announcements`, {
      method: 'POST',
      json: body,
      schema: AnnouncementSchema,
    }),
  deleteAnnouncement: (courseId: string, announcementId: string): Promise<void> =>
    api(`${course(courseId)}/announcements/${enc(announcementId)}`, { method: 'DELETE' }),
};
