import { Injectable } from '@nestjs/common';
import type { MyCourseReview } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { CourseNotFound } from '../../domain/engagement.errors';
import { PeopleDirectory } from '../people';
import { ReviewRepository } from '../ports/review.repository';
import { ReviewEligibility } from '../review-eligibility';
import { reviewAuthorIds, toMyReview } from '../review-views';

/**
 * `GET /me/courses/:courseId/review`: the caller's live review (in any state, so the author
 * sees "hidden by moderation" / "suspended") and whether they may write one now (the "Leave a
 * rating" dialog). Errors: 404 `course_not_found`.
 */
@Injectable()
export class GetMyCourseReviewQuery {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly reviews: ReviewRepository,
    private readonly eligibility: ReviewEligibility,
    private readonly people: PeopleDirectory,
  ) {}

  async execute(input: { userId: string; courseId: string }): Promise<MyCourseReview> {
    const course = await this.catalog.getPublishedCourse(input.courseId);
    if (course === null) throw new CourseNotFound();
    const [review, blockReason] = await Promise.all([
      this.reviews.findLiveByUser(course.id, input.userId),
      this.eligibility.blockReason(input.userId, course),
    ]);
    const people = await this.people.lookup(review === null ? [] : reviewAuthorIds([review]));
    return {
      courseId: course.id,
      review: review === null ? null : toMyReview(review, people),
      canReview: blockReason === null,
      blockReason,
    };
  }
}
