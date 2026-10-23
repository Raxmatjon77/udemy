import { Injectable } from '@nestjs/common';
import type { PublicPrice, PublicPricesResponse } from '@udemy/contracts';
import { Money } from '../../domain/money';
import { CommerceSettings } from '../commerce-settings';
import { CommerceCatalog } from '../ports/context-gateways';
import { PricingRepository } from '../ports/pricing.repository';

/**
 * `GetPublicPrices` (design §5, ≤ 48 ids): `[{courseId, amount, currency, isFree, slug, title}]`
 * for the PUBLISHED courses that have a price in the platform currency, in request order (the
 * live slug and title label the guest cart, P4-T18). Every other
 * id (draft, in review, archived, deleted, unknown, unpriced) is omitted, so the endpoint
 * reveals nothing about unpublished courses.
 */
@Injectable()
export class GetPublicPricesQuery {
  constructor(
    private readonly catalog: CommerceCatalog,
    private readonly pricing: PricingRepository,
    private readonly settings: CommerceSettings,
  ) {}

  async execute(courseIds: readonly string[]): Promise<PublicPricesResponse> {
    const published = (await this.catalog.getCourses(courseIds)).filter(
      (c) => c.status === 'PUBLISHED',
    );
    if (published.length === 0) return { items: [] };
    const prices = new Map(
      (await this.pricing.findPrices(published.map((c) => c.id))).map((p) => [p.courseId, p]),
    );
    const publishedById = new Map(published.map((c) => [c.id, c]));
    const items = [...new Set(courseIds)].flatMap((courseId): PublicPrice[] => {
      const price = prices.get(courseId);
      const course = publishedById.get(courseId);
      if (course === undefined || price === undefined) return [];
      if (price.currency !== this.settings.currency) return [];
      const money = Money.fromDecimal(price.amount, price.currency);
      return [
        {
          courseId,
          amount: money.toDecimal(),
          currency: money.currency,
          isFree: money.isZero(),
          slug: course.slug,
          title: course.title,
        },
      ];
    });
    return { items };
  }
}
