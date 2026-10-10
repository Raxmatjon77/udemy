import { Injectable } from '@nestjs/common';
import { type CartQuote, ErrorCode } from '@udemy/contracts';
import { CouponNotApplicable } from '../../domain/commerce.errors';
import { CartQuoteService } from '../cart-quote.service';
import { CartRepository } from '../ports/cart.repository';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';

export interface ApplyCouponInput {
  readonly userId: string;
  /** The end user's IP as the BFF reports it (per-IP brute-force bucket). */
  readonly ip: string;
  /** Already trimmed and uppercased by the request schema (`^[A-Z0-9_-]{4,20}$`). */
  readonly code: string;
}

/**
 * `ApplyCoupon` (design §5, D4/D5, §9 brute force):
 *
 * 1. Rate limit FIRST, on every apply (20/h per user, 60/h per IP), valid or not.
 * 2. Under the cart lock: store the code, re-quote, and keep it only when it gives at least
 *    one purchasable line a discount (one code per cart; it replaces the previous one).
 * 3. Otherwise roll back (the previous code stays) and answer 422 with the generic
 *    `coupon_invalid` (unknown code, or no line it applies to) or, for a code that does match
 *    the cart, the specific `coupon_expired` / `coupon_not_started` / `coupon_exhausted` /
 *    `coupon_already_used`.
 */
@Injectable()
export class ApplyCouponCommand {
  constructor(
    private readonly carts: CartRepository,
    private readonly quotes: CartQuoteService,
    private readonly limiter: CommerceRateLimiter,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: ApplyCouponInput): Promise<CartQuote> {
    await this.limiter.hitCouponApply(input.userId, input.ip);
    return this.tx.run(async (trx) => {
      await this.carts.lockCart(trx, input.userId);
      await this.carts.setCouponCode(trx, input.userId, input.code);
      const { quote, view } = await this.quotes.price(input.userId, trx);
      if (quote.coupon?.applied !== true) {
        throw new CouponNotApplicable(quote.coupon?.problem ?? ErrorCode.CouponInvalid);
      }
      return view;
    });
  }
}
