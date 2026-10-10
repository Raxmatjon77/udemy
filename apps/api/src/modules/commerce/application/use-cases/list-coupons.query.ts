import { Injectable } from '@nestjs/common';
import type { CouponPage } from '@udemy/contracts';
import { decodeCouponCursor, encodeCouponCursor } from '../coupon-cursor';
import { CouponRepository, type CouponScopeFilter } from '../ports/coupon.repository';
import { toCouponView } from '../views';

export interface ListCouponsInput {
  readonly filter: CouponScopeFilter;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * `ListCoupons` (design §5): newest first, keyset paginated, each coupon with its terms, the
 * derived state and the `{reserved, consumed}` redemption counts.
 */
@Injectable()
export class ListCouponsQuery {
  constructor(private readonly coupons: CouponRepository) {}

  async execute(input: ListCouponsInput): Promise<CouponPage> {
    const afterId = input.cursor === undefined ? undefined : decodeCouponCursor(input.cursor);
    const rows = await this.coupons.list(input.filter, { afterId, limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(toCouponView),
      nextCursor:
        rows.length > input.limit && last !== undefined ? encodeCouponCursor(last.id) : null,
    };
  }
}
