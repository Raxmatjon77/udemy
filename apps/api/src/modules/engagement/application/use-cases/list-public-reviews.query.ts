import { Injectable } from '@nestjs/common';
import type { PublicReviewPage } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { CourseNotFound } from '../../domain/engagement.errors';
import { decodeOptionalKeyset, toPage } from '../engagement-cursor';
import { PeopleDirectory } from '../people';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { ReviewRepository } from '../ports/review.repository';
import { reviewAuthorIds, toPublicReview } from '../review-views';

export interface ListPublicReviewsInput {
  readonly courseId: string;
  readonly rating?: number | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly ip: string;
}

/**
 * `ListPublicReviews` (design §5): PUBLISHED reviews of a live (PUBLISHED or ARCHIVED) course,
 * keyset (createdAt DESC, id DESC), optionally one rating. Authors are public profiles (null
 * for a banned user: "Former student"); a hidden reply is not shown.
 *
 * Errors: 404 `course_not_found`, 422 `validation_failed` (cursor), 429.
 */
@Injectable()
export class ListPublicReviewsQuery {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly catalog: CatalogFacade,
    private readonly reviews: ReviewRepository,
    private readonly people: PeopleDirectory,
  ) {}

  async execute(input: ListPublicReviewsInput): Promise<PublicReviewPage> {
    await this.rateLimiter.hit('publicRead', input.ip);
    const after = decodeOptionalKeyset(input.cursor);
    const course = await this.catalog.getPublishedCourse(input.courseId);
    if (course === null) throw new CourseNotFound();
    const rows = await this.reviews.listPublished({
      courseId: course.id,
      rating: input.rating,
      after: after === null ? null : { createdAt: after.at, id: after.id },
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const people = await this.people.lookup(reviewAuthorIds(page.map((r) => r.review)));
    return toPage(
      rows,
      input.limit,
      (row) => ({ at: row.createdAtKey, id: row.review.id }),
      (pageRows) => pageRows.map((row) => toPublicReview(row.review, people)),
    );
  }
}
