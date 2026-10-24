import { Injectable } from '@nestjs/common';
import { EngagementRateLimiter } from '../ports/engagement-rate-limiter';
import { WishlistRepository } from '../ports/wishlist.repository';

/** `RemoveFromWishlist` (design §5): idempotent 204, whatever the course's state. */
@Injectable()
export class RemoveFromWishlistCommand {
  constructor(
    private readonly rateLimiter: EngagementRateLimiter,
    private readonly wishlist: WishlistRepository,
  ) {}

  async execute(input: { userId: string; courseId: string }): Promise<void> {
    await this.rateLimiter.hit('wishlistWrite', input.userId);
    await this.wishlist.remove(input.userId, input.courseId);
  }
}
