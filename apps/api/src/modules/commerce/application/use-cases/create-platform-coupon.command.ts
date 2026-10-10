import { Injectable } from '@nestjs/common';
import type { Coupon, CreatePlatformCouponRequest } from '@udemy/contracts';
import { InvalidCommerceField } from '../../domain/commerce.errors';
import { platformCouponIssues } from '../../domain/coupon-terms';
import { couponCreatedPayload } from '../coupon-events';
import { CommerceClock } from '../ports/commerce-clock';
import { CommerceEventPublisher } from '../ports/commerce-event.publisher';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { CouponRepository } from '../ports/coupon.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toCouponView } from '../views';

export interface CreatePlatformCouponInput {
  readonly actorId: string;
  readonly request: CreatePlatformCouponRequest;
}

/**
 * `CreatePlatformCoupon` (design §5, D5), admin with `platform_coupon:manage`: PERCENT only, a
 * window of at most 90 days that ends in the future and starts at most 90 days ahead. Platform
 * codes share one namespace (409 `coupon_code_taken`); they may equal a course coupon's code,
 * in which case the best of the two wins per line (tie: the course coupon). `CouponCreated` in
 * the same transaction. Rate limit: 50 creations per user per 24 h.
 */
@Injectable()
export class CreatePlatformCouponCommand {
  constructor(
    private readonly coupons: CouponRepository,
    private readonly events: CommerceEventPublisher,
    private readonly limiter: CommerceRateLimiter,
    private readonly clock: CommerceClock,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: CreatePlatformCouponInput): Promise<Coupon> {
    await this.limiter.hitCouponCreate(input.actorId);
    const req = input.request;
    return this.tx.run(async (trx) => {
      const now = await this.clock.now(trx);
      const window = {
        startsAt: req.startsAt === undefined ? now : new Date(req.startsAt),
        endsAt: new Date(req.endsAt),
      };
      const issues = platformCouponIssues({ window, now });
      if (issues.length > 0) throw new InvalidCommerceField(issues);
      const id = await this.coupons.insert(trx, {
        scope: 'PLATFORM',
        courseId: null,
        code: req.code,
        discountType: 'PERCENT',
        percentOff: req.percentOff,
        amountOff: null,
        currency: null,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        maxRedemptions: req.maxRedemptions ?? null,
        createdBy: input.actorId,
      });
      const created = await this.coupons.findById(id, { scope: 'PLATFORM' }, trx);
      if (created === null) throw new Error(`coupon ${id} vanished inside its own transaction`);
      await this.events.couponCreated(trx, couponCreatedPayload(created, input.actorId));
      return toCouponView(created);
    });
  }
}
