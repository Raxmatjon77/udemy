import { Injectable } from '@nestjs/common';
import { type Coupon, COUPON_LIMITS, type CreateCourseCouponRequest } from '@udemy/contracts';
import {
  CouponLimitExceeded,
  CouponOnFreeCourse,
  CouponOnUnpricedCourse,
  InvalidCommerceField,
} from '../../domain/commerce.errors';
import { type CouponDiscount, courseCouponIssues } from '../../domain/coupon-terms';
import { Money } from '../../domain/money';
import { couponCreatedPayload } from '../coupon-events';
import { CommerceClock } from '../ports/commerce-clock';
import { CommerceEventPublisher } from '../ports/commerce-event.publisher';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { CouponRepository } from '../ports/coupon.repository';
import { PricingRepository } from '../ports/pricing.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toCouponView } from '../views';

export interface CreateCourseCouponInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly request: CreateCourseCouponRequest;
}

/**
 * `CreateCourseCoupon` (design §5, D5), owner-only through the course policy:
 *
 * 1. Rate limit: 50 coupon creations per user per 24 h.
 * 2. Under the `course_prices` row lock (schema doc R8; it serialises the active count and the
 *    AMOUNT ≤ list rule against concurrent price changes): the course needs a price
 *    (422 `course_not_for_sale`) that is not 0.00 (422 `course_is_free`).
 * 3. Terms: PERCENT 1–100 or AMOUNT in (0, list]; a 1–31 day window that ends in the future and
 *    starts at most 90 days ahead (default: now); 422 `validation_failed` with field issues.
 *    "Now" is the transaction's `now()` (`CommerceClock`), the clock the CHECKs and the derived
 *    state use.
 * 4. At most 10 active (not deactivated, not expired) coupons: 422 `coupon_limit_exceeded`.
 * 5. Insert (409 `coupon_code_taken`: codes are unique per course and never reused) and
 *    `CouponCreated`, in the same transaction.
 */
@Injectable()
export class CreateCourseCouponCommand {
  constructor(
    private readonly coupons: CouponRepository,
    private readonly pricing: PricingRepository,
    private readonly events: CommerceEventPublisher,
    private readonly limiter: CommerceRateLimiter,
    private readonly clock: CommerceClock,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: CreateCourseCouponInput): Promise<Coupon> {
    await this.limiter.hitCouponCreate(input.actorId);
    const req = input.request;
    return this.tx.run(async (trx) => {
      const now = await this.clock.now(trx);
      const window = {
        startsAt: req.startsAt === undefined ? now : new Date(req.startsAt),
        endsAt: new Date(req.endsAt),
      };
      const price = await this.pricing.lockPrice(trx, input.courseId);
      if (price === null) throw new CouponOnUnpricedCourse();
      const list = Money.fromDecimal(price.amount, price.currency);
      if (list.isZero()) throw new CouponOnFreeCourse();

      const discount: CouponDiscount =
        req.discountType === 'PERCENT'
          ? { type: 'PERCENT', percentOff: req.percentOff }
          : { type: 'AMOUNT', amountOff: Money.fromDecimal(req.amountOff, list.currency) };
      const issues = courseCouponIssues({ window, now, discount, listPrice: list });
      if (issues.length > 0) throw new InvalidCommerceField(issues);

      const active = await this.coupons.countActiveForCourse(trx, input.courseId);
      if (active >= COUPON_LIMITS.maxActivePerCourse) {
        throw new CouponLimitExceeded(COUPON_LIMITS.maxActivePerCourse);
      }
      const id = await this.coupons.insert(trx, {
        scope: 'COURSE',
        courseId: input.courseId,
        code: req.code,
        discountType: discount.type,
        percentOff: discount.type === 'PERCENT' ? discount.percentOff : null,
        amountOff: discount.type === 'AMOUNT' ? discount.amountOff.toDecimal() : null,
        currency: discount.type === 'AMOUNT' ? discount.amountOff.currency : null,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        maxRedemptions: req.maxRedemptions ?? null,
        createdBy: input.actorId,
      });
      const created = await this.coupons.findById(
        id,
        { scope: 'COURSE', courseId: input.courseId },
        trx,
      );
      if (created === null) throw new Error(`coupon ${id} vanished inside its own transaction`);
      await this.events.couponCreated(trx, couponCreatedPayload(created, input.actorId));
      return toCouponView(created);
    });
  }
}
