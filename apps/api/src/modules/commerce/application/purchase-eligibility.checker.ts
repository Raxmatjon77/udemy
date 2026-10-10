import { Injectable } from '@nestjs/common';
import type { PurchaseBlockReason } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { Money } from '../domain/money';
import { purchaseBlockReason } from '../domain/purchase-eligibility';
import { CommerceSettings } from './commerce-settings';
import { CommerceCatalog, CommerceEnrollments } from './ports/context-gateways';
import { PricingRepository } from './ports/pricing.repository';

/**
 * Batch purchase eligibility (design §4) for AddToCart and MergeGuestCart: one catalog call,
 * one price query and one enrollment query, whatever the number of ids. Returns the first
 * failing check per id (null = may be bought).
 */
@Injectable()
export class PurchaseEligibilityChecker {
  constructor(
    private readonly catalog: CommerceCatalog,
    private readonly pricing: PricingRepository,
    private readonly enrollments: CommerceEnrollments,
    private readonly settings: CommerceSettings,
  ) {}

  async check(
    userId: string,
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlyMap<string, PurchaseBlockReason | null>> {
    const ids = [...new Set(courseIds)];
    if (ids.length === 0) return new Map();
    const courses = new Map((await this.catalog.getCourses(ids, ex)).map((c) => [c.id, c]));
    const known = ids.filter((id) => courses.has(id));
    const prices = new Map(
      (known.length === 0 ? [] : await this.pricing.findPrices(known, ex)).map((p) => [
        p.courseId,
        Money.fromDecimal(p.amount, p.currency),
      ]),
    );
    const enrolled =
      known.length === 0
        ? new Set<string>()
        : await this.enrollments.activeCourseIds(userId, known, ex);
    return new Map(
      ids.map((id) => [
        id,
        purchaseBlockReason({
          course: courses.get(id) ?? null,
          price: prices.get(id) ?? null,
          currency: this.settings.currency,
          userId,
          enrolled: enrolled.has(id),
        }),
      ]),
    );
  }
}
