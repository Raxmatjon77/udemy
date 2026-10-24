import { Injectable } from '@nestjs/common';
import type { InstructorReviewPage } from '@udemy/contracts';
import { decodeOptionalKeyset, toPage } from '../engagement-cursor';
import { PeopleDirectory } from '../people';
import { ReviewRepository } from '../ports/review.repository';
import { reviewAuthorIds, toInstructorReview } from '../review-views';

export interface ListCourseReviewsInput {
  /** Already authorised by `@CheckPolicy({ resource: 'course', action: 'engage' })`. */
  readonly courseId: string;
  readonly rating?: number | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * `ListCourseReviewsForInstructor` (design §5): every non-deleted review of the owner's course
 * with its state (PUBLISHED / HIDDEN / SUSPENDED) and reply (hidden flagged), newest first.
 * A never-published course simply has none.
 */
@Injectable()
export class ListCourseReviewsQuery {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly people: PeopleDirectory,
  ) {}

  async execute(input: ListCourseReviewsInput): Promise<InstructorReviewPage> {
    const after = decodeOptionalKeyset(input.cursor);
    const rows = await this.reviews.listLive({
      courseId: input.courseId,
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
      (pageRows) => pageRows.map((row) => toInstructorReview(row.review, people)),
    );
  }
}
