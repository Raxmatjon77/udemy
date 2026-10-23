import { Injectable } from '@nestjs/common';
import type { PurchaseStatesResponse } from '@udemy/contracts';
import { CommerceSettings } from '../commerce-settings';
import { CartRepository } from '../ports/cart.repository';
import { CommerceCatalog, CommerceEnrollments } from '../ports/context-gateways';
import { PricingRepository } from '../ports/pricing.repository';

/**
 * `GetPurchaseStates` (design §5, ≤ 48 ids): one item per requested id, composed from
 * enrollment (ACTIVE, whatever the course status, D13), the server cart and the catalog
 * (owner, status) and pricing. `forSale` (additive, P4-T18) is exactly "the id is in
 * `GET /commerce/prices`": PUBLISHED with a price in the platform currency. Unknown ids answer
 * all-false (nothing is revealed about them).
 */
@Injectable()
export class GetPurchaseStatesQuery {
  constructor(
    private readonly catalog: CommerceCatalog,
    private readonly enrollments: CommerceEnrollments,
    private readonly carts: CartRepository,
    private readonly pricing: PricingRepository,
    private readonly settings: CommerceSettings,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly courseIds: readonly string[];
  }): Promise<PurchaseStatesResponse> {
    const ids = [...new Set(input.courseIds)];
    const courses = await this.catalog.getCourses(ids);
    const owners = new Map(courses.map((c) => [c.id, c.ownerId]));
    const published = courses.filter((c) => c.status === 'PUBLISHED').map((c) => c.id);
    const forSale = new Set(
      published.length === 0
        ? []
        : (await this.pricing.findPrices(published))
            .filter((p) => p.currency === this.settings.currency)
            .map((p) => p.courseId),
    );
    const enrolled = await this.enrollments.activeCourseIds(input.userId, ids);
    const inCart = await this.carts.findInCart(input.userId, ids);
    return {
      items: ids.map((courseId) => ({
        courseId,
        enrolled: enrolled.has(courseId),
        inCart: inCart.has(courseId),
        isOwner: owners.get(courseId) === input.userId,
        forSale: forSale.has(courseId),
      })),
    };
  }
}
