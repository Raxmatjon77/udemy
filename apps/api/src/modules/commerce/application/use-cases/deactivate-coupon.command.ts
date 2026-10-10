import { Injectable } from '@nestjs/common';
import type { Coupon } from '@udemy/contracts';
import { CouponNotFound } from '../../domain/commerce.errors';
import { couponDeactivatedPayload } from '../coupon-events';
import { CommerceEventPublisher } from '../ports/commerce-event.publisher';
import { CouponRepository, type CouponScopeFilter } from '../ports/coupon.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toCouponView } from '../views';

export interface DeactivateCouponInput {
  readonly actorId: string;
  readonly couponId: string;
  /** The course of the route (owner via the course policy), or the platform (admin). */
  readonly filter: CouponScopeFilter;
}

/**
 * `DeactivateCoupon` (design §5): the only change a coupon allows, once (D5). Idempotent: a
 * repeat answers 200 with the coupon as it is, and only the first call writes
 * `CouponDeactivated`. The id is resolved within the scope, so another course's coupon (or a
 * course coupon on the admin route) is 404. Existing RESERVED redemptions stay honoured
 * (price locked at checkout, schema doc R1).
 */
@Injectable()
export class DeactivateCouponCommand {
  constructor(
    private readonly coupons: CouponRepository,
    private readonly events: CommerceEventPublisher,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: DeactivateCouponInput): Promise<Coupon> {
    return this.tx.run(async (trx) => {
      const changed = await this.coupons.deactivate(
        trx,
        input.couponId,
        input.filter,
        input.actorId,
      );
      const coupon = await this.coupons.findById(input.couponId, input.filter, trx);
      if (coupon === null) throw new CouponNotFound();
      if (changed) {
        if (coupon.deactivatedAt === null)
          throw new Error('deactivated coupon without a timestamp');
        await this.events.couponDeactivated(
          trx,
          couponDeactivatedPayload(
            { ...coupon, deactivatedAt: coupon.deactivatedAt },
            input.actorId,
          ),
        );
      }
      return toCouponView(coupon);
    });
  }
}
