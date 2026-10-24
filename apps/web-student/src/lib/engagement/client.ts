import {
  AnswerPageSchema,
  AnswerSchema,
  MyCourseReviewSchema,
  MyReviewSchema,
  PublicReviewPageSchema,
  QuestionDetailSchema,
  QuestionPageSchema,
  QuestionSchema,
  RatingsResponseSchema,
  REPORT_SUBJECT_PATHS,
  ReportSchema,
  WishlistPageSchema,
  WishlistStatesResponseSchema,
  type Answer,
  type AnswerPage,
  type AskQuestionRequest,
  type CourseRating,
  type MyCourseReview,
  type MyReview,
  type PublicReviewPage,
  type QaSort,
  type Question,
  type QuestionDetail,
  type QuestionPage,
  type Report,
  type ReportContentRequest,
  type ReportSubjectType,
  type UpsertReviewRequest,
  type WishlistPage,
  type WishlistState,
} from '@udemy/contracts';
import { REALTIME_QUERY_ROOTS } from '@udemy/web-realtime';

import { api, queryString } from '../api';

/**
 * Browser calls of the Phase 5 engagement routes (learning experience design §8): ratings and
 * reviews, the wishlist, Q&A and reports, through this app's BFF.
 */

const id = (value: string) => encodeURIComponent(value);
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});

export interface QuestionFilters {
  /** Only this lecture's questions; null = the whole course. */
  lectureId: string | null;
  sort: QaSort;
  /** Title search (≥ 3 characters), or ''. */
  q: string;
}

/**
 * Query keys. Q&A keys start with `['qa', courseId]` (`REALTIME_QUERY_ROOTS.qa`), so a
 * `qa.changed` hint from the course room invalidates every Q&A list and thread of the course.
 */
export const engagementKeys = {
  ratings: (courseIds: readonly string[]) =>
    ['engagement', 'ratings', [...courseIds].sort()] as const,
  publicReviews: (courseId: string, rating: number | null) =>
    ['engagement', 'reviews', courseId, rating] as const,
  myReview: (courseId: string) => ['engagement', 'my-review', courseId] as const,
  wishlistAll: ['me', 'wishlist'] as const,
  wishlist: ['me', 'wishlist', 'list'] as const,
  wishlistStates: (courseIds: readonly string[]) =>
    ['me', 'wishlist', 'states', [...courseIds].sort()] as const,
  qa: (courseId: string) => REALTIME_QUERY_ROOTS.qa(courseId),
  questions: (courseId: string, filters: QuestionFilters) =>
    [...REALTIME_QUERY_ROOTS.qa(courseId), 'list', filters] as const,
  question: (courseId: string, questionId: string) =>
    [...REALTIME_QUERY_ROOTS.qa(courseId), 'question', questionId] as const,
};

/* ------------------------------------------------------------------ ratings and reviews */

/** `GET /engagement/ratings?courseIds=` (public, ≤ 48 ids). */
export async function fetchRatings(
  courseIds: readonly string[],
  signal?: AbortSignal,
): Promise<CourseRating[]> {
  if (courseIds.length === 0) return [];
  const response = await api(
    `/engagement/ratings${queryString({ courseIds: courseIds.join(',') })}`,
    {
      schema: RatingsResponseSchema,
      quiet: true,
      ...signalOf(signal),
    },
  );
  return response.items;
}

/** `GET /engagement/courses/:courseId/reviews?rating=&cursor=` (public keyset page). */
export function fetchPublicReviews(
  courseId: string,
  rating: number | null,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<PublicReviewPage> {
  return api(`/engagement/courses/${id(courseId)}/reviews${queryString({ rating, cursor })}`, {
    schema: PublicReviewPageSchema,
    quiet: true,
    ...signalOf(signal),
  });
}

/** `GET /me/courses/:courseId/review`: my review and whether I may (still) write one. */
export function fetchMyCourseReview(
  courseId: string,
  signal?: AbortSignal,
): Promise<MyCourseReview> {
  return api(`/me/courses/${id(courseId)}/review`, {
    schema: MyCourseReviewSchema,
    ...signalOf(signal),
  });
}

export function upsertMyReview(courseId: string, body: UpsertReviewRequest): Promise<MyReview> {
  return api(`/me/courses/${id(courseId)}/review`, {
    method: 'PUT',
    json: body,
    schema: MyReviewSchema,
  });
}

export function deleteMyReview(courseId: string): Promise<void> {
  return api(`/me/courses/${id(courseId)}/review`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------ wishlist */

export function fetchWishlist(cursor: string | null, signal?: AbortSignal): Promise<WishlistPage> {
  return api(`/me/wishlist${queryString({ cursor })}`, {
    schema: WishlistPageSchema,
    ...signalOf(signal),
  });
}

/** Quiet: the landing page asks for a signed-in visitor only, but never forces a login. */
export async function fetchWishlistStates(
  courseIds: readonly string[],
  signal?: AbortSignal,
): Promise<WishlistState[]> {
  const response = await api(
    `/me/wishlist/states${queryString({ courseIds: courseIds.join(',') })}`,
    { schema: WishlistStatesResponseSchema, quiet: true, ...signalOf(signal) },
  );
  return response.items;
}

export function addToWishlist(courseId: string): Promise<void> {
  return api(`/me/wishlist/${id(courseId)}`, { method: 'PUT' });
}

export function removeFromWishlist(courseId: string): Promise<void> {
  return api(`/me/wishlist/${id(courseId)}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------ Q&A */

const questionsPath = (courseId: string) => `/courses/${id(courseId)}/questions`;

export function fetchQuestions(
  courseId: string,
  filters: QuestionFilters,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<QuestionPage> {
  return api(
    `${questionsPath(courseId)}${queryString({
      lectureId: filters.lectureId,
      sort: filters.sort,
      q: filters.q,
      cursor,
    })}`,
    { schema: QuestionPageSchema, ...signalOf(signal) },
  );
}

export function fetchQuestion(
  courseId: string,
  questionId: string,
  signal?: AbortSignal,
): Promise<QuestionDetail> {
  return api(`${questionsPath(courseId)}/${id(questionId)}`, {
    schema: QuestionDetailSchema,
    ...signalOf(signal),
  });
}

export function fetchAnswers(
  courseId: string,
  questionId: string,
  cursor: string | null,
): Promise<AnswerPage> {
  return api(`${questionsPath(courseId)}/${id(questionId)}/answers${queryString({ cursor })}`, {
    schema: AnswerPageSchema,
  });
}

export function askQuestion(courseId: string, body: AskQuestionRequest): Promise<Question> {
  return api(questionsPath(courseId), { method: 'POST', json: body, schema: QuestionSchema });
}

export function postAnswer(courseId: string, questionId: string, bodyMd: string): Promise<Answer> {
  return api(`${questionsPath(courseId)}/${id(questionId)}/answers`, {
    method: 'POST',
    json: { bodyMd },
    schema: AnswerSchema,
  });
}

export function deleteQuestion(courseId: string, questionId: string): Promise<void> {
  return api(`${questionsPath(courseId)}/${id(questionId)}`, { method: 'DELETE' });
}

export function deleteAnswer(courseId: string, answerId: string): Promise<void> {
  return api(`/courses/${id(courseId)}/answers/${id(answerId)}`, { method: 'DELETE' });
}

/** Up-vote (`on`) or withdraw the vote; idempotent (422 `cannot_vote_own_content`). */
export function setVote(
  courseId: string,
  subject: 'questions' | 'answers',
  subjectId: string,
  on: boolean,
): Promise<void> {
  return api(`/courses/${id(courseId)}/${subject}/${id(subjectId)}/vote`, {
    method: on ? 'PUT' : 'DELETE',
  });
}

/** Accept an answer (question author or course owner), or clear it (`answerId` null). */
export function setAcceptedAnswer(
  courseId: string,
  questionId: string,
  answerId: string | null,
): Promise<Question> {
  const path = `${questionsPath(courseId)}/${id(questionId)}/accepted-answer`;
  return answerId === null
    ? api(path, { method: 'DELETE', schema: QuestionSchema })
    : api(path, { method: 'PUT', json: { answerId }, schema: QuestionSchema });
}

/* ------------------------------------------------------------------ reports */

/** `POST /engagement/{type}/:id/reports` (a repeat returns the existing report). */
export function reportContent(
  type: ReportSubjectType,
  subjectId: string,
  body: ReportContentRequest,
): Promise<Report> {
  return api(`/engagement/${REPORT_SUBJECT_PATHS[type]}/${id(subjectId)}/reports`, {
    method: 'POST',
    json: body,
    schema: ReportSchema,
  });
}
