import 'server-only';
import {
  PUBLIC_RATINGS_MAX_IDS,
  RatingsResponseSchema,
  type CourseCardPage,
  type CourseRating,
} from '@udemy/contracts';

import { getJson, settle, type Loaded } from '../catalog/server';

/**
 * Server-side reads of the public ratings (learning experience design D11, §8 Public):
 * anonymous like the catalog and the prices, so a page is the same for everybody.
 */

/** Course id → its rating summary. A course missing from the map has no reviews. */
export type RatingMap = Readonly<Record<string, CourseRating>>;

export function toRatingMap(ratings: readonly CourseRating[]): RatingMap {
  return Object.fromEntries(ratings.map((rating) => [rating.courseId, rating]));
}

/** `GET /engagement/ratings?courseIds=` in batches of `PUBLIC_RATINGS_MAX_IDS`. */
export async function getCourseRatings(courseIds: readonly string[]): Promise<CourseRating[]> {
  const unique = [...new Set(courseIds)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += PUBLIC_RATINGS_MAX_IDS) {
    batches.push(unique.slice(i, i + PUBLIC_RATINGS_MAX_IDS));
  }
  const responses = await Promise.all(
    batches.map((ids) =>
      getJson(
        `/engagement/ratings?${new URLSearchParams({ courseIds: ids.join(',') }).toString()}`,
        RatingsResponseSchema,
      ),
    ),
  );
  return responses.flatMap((response) => response.items);
}

/** The ratings of a loaded course page; undefined when there is none or they failed to load. */
export async function ratingsForPage(page: Loaded<CourseCardPage>): Promise<RatingMap | undefined> {
  if (!page.ok) return undefined;
  if (page.data.items.length === 0) return {};
  const ratings = await settle(getCourseRatings(page.data.items.map((course) => course.id)));
  return ratings.ok ? toRatingMap(ratings.data) : undefined;
}

/** One course's rating summary, or undefined when it could not be loaded. */
export async function ratingForCourse(courseId: string): Promise<CourseRating | undefined> {
  const ratings = await settle(getCourseRatings([courseId]));
  return ratings.ok ? ratings.data.find((rating) => rating.courseId === courseId) : undefined;
}
