import {
  CourseCardPageSchema,
  PublicArticleSchema,
  type CourseCardPage,
  type PublicArticle,
} from '@udemy/contracts';

import { api } from '../api';
import { browseApiPath, type BrowseFilters } from './browse-params';

/**
 * Browser reads of the public catalog, through this app's BFF (`/api/proxy/catalog/*`).
 * `quiet`: these pages are public, so a 401 never sends anybody to the login page.
 */

export const catalogQueryKeys = {
  courses: (filters: BrowseFilters, limit: number) =>
    ['catalog', 'courses', { ...filters }, limit] as const,
  article: (courseId: string, lectureId: string) =>
    ['catalog', 'article', courseId, lectureId] as const,
};

/** One keyset page of `GET /catalog/courses`; `cursor` is the API's `nextCursor`, verbatim. */
export function fetchCoursePage(
  filters: BrowseFilters,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<CourseCardPage> {
  return api(browseApiPath(filters, { cursor, limit }), {
    schema: CourseCardPageSchema,
    quiet: true,
    ...(signal ? { signal } : {}),
  });
}

/** `GET /catalog/courses/:courseId/lectures/:lectureId/article` (free-preview articles). */
export function fetchPreviewArticle(
  courseId: string,
  lectureId: string,
  signal?: AbortSignal,
): Promise<PublicArticle> {
  return api(
    `/catalog/courses/${encodeURIComponent(courseId)}/lectures/${encodeURIComponent(lectureId)}/article`,
    { schema: PublicArticleSchema, quiet: true, ...(signal ? { signal } : {}) },
  );
}
