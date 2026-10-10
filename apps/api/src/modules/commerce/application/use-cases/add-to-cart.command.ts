import { Injectable } from '@nestjs/common';
import type { CartQuote } from '@udemy/contracts';
import { CartFull, purchaseBlockedError } from '../../domain/commerce.errors';
import { CartQuoteService } from '../cart-quote.service';
import { CommerceSettings } from '../commerce-settings';
import { CartRepository } from '../ports/cart.repository';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';
import { PurchaseEligibilityChecker } from '../purchase-eligibility.checker';

export interface AddToCartInput {
  readonly userId: string;
  readonly courseId: string;
}

/**
 * `AddToCart` (design §5): rate limit (cart writes, 120/h), then under the cart row lock
 * (lock order step 1): purchase eligibility in order (404 `course_not_found`, 409
 * `course_not_for_sale` / `course_is_free` / `cannot_purchase_own_course` / `already_enrolled`),
 * the size limit (422 `cart_full`, counted under the lock) and `ON CONFLICT DO NOTHING`, so
 * adding twice is a 200. Returns the fresh quote.
 */
@Injectable()
export class AddToCartCommand {
  constructor(
    private readonly carts: CartRepository,
    private readonly eligibility: PurchaseEligibilityChecker,
    private readonly quotes: CartQuoteService,
    private readonly limiter: CommerceRateLimiter,
    private readonly tx: TransactionRunner,
    private readonly settings: CommerceSettings,
  ) {}

  async execute(input: AddToCartInput): Promise<CartQuote> {
    await this.limiter.hitCartWrite(input.userId);
    return this.tx.run(async (trx) => {
      await this.carts.lockCart(trx, input.userId);
      const reason = (await this.eligibility.check(input.userId, [input.courseId], trx)).get(
        input.courseId,
      );
      if (reason !== null && reason !== undefined) throw purchaseBlockedError(reason);
      const items = await this.carts.listCourseIds(input.userId, trx);
      if (!items.includes(input.courseId)) {
        if (items.length >= this.settings.cartMaxItems) {
          throw new CartFull(this.settings.cartMaxItems);
        }
        await this.carts.addItem(trx, input.userId, input.courseId);
      }
      return (await this.quotes.price(input.userId, trx)).view;
    });
  }
}
