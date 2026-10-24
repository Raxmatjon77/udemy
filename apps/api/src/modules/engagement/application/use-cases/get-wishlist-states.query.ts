import { Injectable } from '@nestjs/common';
import type { WishlistStatesResponse } from '@udemy/contracts';
import { WishlistRepository } from '../ports/wishlist.repository';

/** `GetWishlistStates`: one item per requested id (1–48), in request order (the course hearts). */
@Injectable()
export class GetWishlistStatesQuery {
  constructor(private readonly wishlist: WishlistRepository) {}

  async execute(input: {
    userId: string;
    courseIds: readonly string[];
  }): Promise<WishlistStatesResponse> {
    const wishlisted = await this.wishlist.wishlistedAmong(input.userId, input.courseIds);
    return {
      items: input.courseIds.map((courseId) => ({
        courseId,
        wishlisted: wishlisted.has(courseId),
      })),
    };
  }
}
