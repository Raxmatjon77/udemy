import { Injectable } from '@nestjs/common';
import type { PurchaseStatesResponse } from '@udemy/contracts';
import { CartRepository } from '../ports/cart.repository';
import { CommerceCatalog, CommerceEnrollments } from '../ports/context-gateways';

/**
 * `GetPurchaseStates` (design §5, ≤ 48 ids): one item per requested id, composed from
 * enrollment (ACTIVE, whatever the course status, D13), the server cart and the catalog
 * (owner). Unknown ids answer all-false (nothing is revealed about them).
 */
@Injectable()
export class GetPurchaseStatesQuery {
  constructor(
    private readonly catalog: CommerceCatalog,
    private readonly enrollments: CommerceEnrollments,
    private readonly carts: CartRepository,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly courseIds: readonly string[];
  }): Promise<PurchaseStatesResponse> {
    const ids = [...new Set(input.courseIds)];
    const owners = new Map((await this.catalog.getCourses(ids)).map((c) => [c.id, c.ownerId]));
    const enrolled = await this.enrollments.activeCourseIds(input.userId, ids);
    const inCart = await this.carts.findInCart(input.userId, ids);
    return {
      items: ids.map((courseId) => ({
        courseId,
        enrolled: enrolled.has(courseId),
        inCart: inCart.has(courseId),
        isOwner: owners.get(courseId) === input.userId,
      })),
    };
  }
}
