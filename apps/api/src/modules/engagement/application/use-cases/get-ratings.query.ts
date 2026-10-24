import { Injectable } from '@nestjs/common';
import type { RatingsResponse } from '@udemy/contracts';
import { toCourseRating } from '../../domain/review';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { ReviewRepository } from '../ports/review.repository';

export interface GetRatingsInput {
  /** 1–48 distinct ids (the request schema checks). */
  readonly courseIds: readonly string[];
  /** The end user's IP (public read limit, 240/min). */
  readonly ip: string;
}

/**
 * `GetRatings` (design §5, D11): one item per requested id, in request order, from the
 * `course_rating_stats` read model (eventually consistent: the worker recomputes it on every
 * review event). A course without a row has no reviews yet: `{ count: 0, average: null }`.
 * Unknown course ids are not an error (the cards ask in batches).
 */
@Injectable()
export class GetRatingsQuery {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly reviews: ReviewRepository,
  ) {}

  async execute(input: GetRatingsInput): Promise<RatingsResponse> {
    await this.rateLimiter.hit('publicRead', input.ip);
    const stats = await this.reviews.getRatings(input.courseIds);
    const byCourse = new Map(stats.map((s) => [s.courseId, s]));
    return {
      items: input.courseIds.map((courseId) => toCourseRating(courseId, byCourse.get(courseId))),
    };
  }
}
