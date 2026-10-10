import { Injectable } from '@nestjs/common';
import { COURSE_PRICING_HISTORY_LIMIT, type CoursePricing } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { PricingRepository } from '../ports/pricing.repository';
import { toCoursePricingView } from '../views';

/**
 * `GetCoursePricing` (design §5): the current price (null = not for sale, D16), `isFree`, and
 * the last 20 changes (newest first, `previousAmount` from the full history). Course
 * existence and ownership are the course policy's job (404 for foreign/deleted courses).
 */
@Injectable()
export class GetCoursePricingQuery {
  constructor(private readonly pricing: PricingRepository) {}

  async execute(courseId: string, ex?: Executor): Promise<CoursePricing> {
    const price = await this.pricing.findPrice(courseId, ex);
    const history =
      price === null
        ? []
        : await this.pricing.listHistory(courseId, COURSE_PRICING_HISTORY_LIMIT, ex);
    return toCoursePricingView(courseId, price, history);
  }
}
