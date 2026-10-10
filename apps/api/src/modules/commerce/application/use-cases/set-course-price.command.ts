import { Injectable } from '@nestjs/common';
import type { CoursePricing } from '@udemy/contracts';
import { PriceTier } from '../../domain/price-tier';
import { CommerceSettings } from '../commerce-settings';
import { CommerceEventPublisher } from '../ports/commerce-event.publisher';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { PricingRepository } from '../ports/pricing.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { GetCoursePricingQuery } from './get-course-pricing.query';

export interface SetCoursePriceInput {
  readonly actorId: string;
  readonly courseId: string;
  /** Decimal string; must be one of the platform currency's `PRICE_TIERS` ("0.00" = free). */
  readonly amount: string;
}

/**
 * `SetCoursePrice` (design §5, D2): effective immediately, also for drafts and courses in
 * review (pricing is commerce data, not part of the moderated revision).
 *
 * 1. Tier validation (422 `price_not_allowed`), before anything else.
 * 2. Unchanged price: a no-op 200 that neither counts against the rate limit nor writes history.
 * 3. Rate limit: 10 changes per course per 24 h (429).
 * 4. One transaction: the upsert (the trigger appends `course_price_changes`) and
 *    `CoursePriceChanged` with `previousAmount` from `RETURNING old.amount`, so two concurrent
 *    first prices still get a correct previous amount. A concurrent identical change makes
 *    the upsert a no-op (no event).
 *
 * Owner-only through `@CheckPolicy({ resource: 'course', action: 'update' })`.
 */
@Injectable()
export class SetCoursePriceCommand {
  constructor(
    private readonly pricing: PricingRepository,
    private readonly events: CommerceEventPublisher,
    private readonly limiter: CommerceRateLimiter,
    private readonly tx: TransactionRunner,
    private readonly settings: CommerceSettings,
    private readonly getPricing: GetCoursePricingQuery,
  ) {}

  async execute(input: SetCoursePriceInput): Promise<CoursePricing> {
    const tier = PriceTier.of(input.amount, this.settings.currency);
    const amount = tier.price.toDecimal();
    const current = await this.pricing.findPrice(input.courseId);
    if (current?.amount === amount && current.currency === tier.price.currency) {
      return this.getPricing.execute(input.courseId);
    }
    await this.limiter.hitPriceChange(input.courseId);
    return this.tx.run(async (trx) => {
      const change = await this.pricing.upsertPrice(trx, {
        courseId: input.courseId,
        amount,
        currency: tier.price.currency,
        updatedBy: input.actorId,
      });
      if (change !== null) {
        await this.events.coursePriceChanged(trx, {
          courseId: input.courseId,
          previousAmount: change.previousAmount,
          amount: change.amount,
          currency: change.currency,
          changedBy: input.actorId,
          changedAt: change.changedAt.toISOString(),
        });
      }
      return this.getPricing.execute(input.courseId, trx);
    });
  }
}
