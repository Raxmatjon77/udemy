import { Injectable } from '@nestjs/common';
import { CatalogFacade } from '../../../catalog';
import { EnrollmentFacade } from '../../../enrollment';
import {
  CourseNotFound,
  CourseNotWishlistable,
  WishlistFull,
} from '../../domain/engagement.errors';
import { decideWishlistAdd, isWishlistFull } from '../../domain/wishlist';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { WishlistRepository } from '../ports/wishlist.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/**
 * `AddToWishlist` (design §5, D19), idempotent: an item already on the list is a 204 whatever
 * the course's state now. Otherwise the course must be PUBLISHED, not the caller's, and the
 * caller not enrolled; the 1000-item cap is counted under the user's `wish` advisory lock and
 * the insert is `ON CONFLICT DO NOTHING`. No events in Phase 5.
 *
 * Errors: 404 `course_not_found`, 409 `course_not_wishlistable`, 422 `wishlist_full`, 429.
 */
@Injectable()
export class AddToWishlistCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly catalog: CatalogFacade,
    private readonly enrollment: EnrollmentFacade,
    private readonly wishlist: WishlistRepository,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: { userId: string; courseId: string }): Promise<void> {
    await this.rateLimiter.hit('wishlistWrite', input.userId);
    const course = await this.catalog.getPublishedCourse(input.courseId);
    if (course === null) throw new CourseNotFound();
    if (await this.wishlist.contains(input.userId, course.id)) return;
    const hasActiveEnrollment =
      course.ownerId !== input.userId && (await this.enrollment.hasAccess(input.userId, course.id));
    switch (decideWishlistAdd({ course, userId: input.userId, hasActiveEnrollment })) {
      case 'COURSE_NOT_FOUND':
        throw new CourseNotFound();
      case 'NOT_WISHLISTABLE':
        throw new CourseNotWishlistable();
      case 'ELIGIBLE':
        break;
    }
    await this.tx.run(async (trx) => {
      const itemCount = await this.wishlist.lockCap(trx, input.userId);
      // Re-checked under the lock: a parallel add of the same course must stay a no-op, not a 422.
      if (await this.wishlist.contains(input.userId, course.id, trx)) return;
      if (isWishlistFull(itemCount)) throw new WishlistFull();
      await this.wishlist.add(trx, input.userId, course.id);
    });
  }
}
