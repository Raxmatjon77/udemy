import { Injectable } from '@nestjs/common';
import { ErrorCode, type MergeGuestCartResponse, type MergeSkipReason } from '@udemy/contracts';
import { CartQuoteService } from '../cart-quote.service';
import { CommerceSettings } from '../commerce-settings';
import { CartRepository } from '../ports/cart.repository';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';
import { PurchaseEligibilityChecker } from '../purchase-eligibility.checker';

export interface MergeGuestCartInput {
  readonly userId: string;
  /** The guest (`localStorage`) cart, ≤ 20 unique ids, in the guest's order. */
  readonly courseIds: readonly string[];
}

/**
 * `MergeGuestCart` (design §5, D4): best effort, under the cart row lock. Each id, in order:
 *
 * - already in the server cart: neither added nor skipped;
 * - not eligible: skipped with its eligibility reason (§4 order);
 * - no room left: skipped with `cart_full`;
 * - otherwise added.
 *
 * A partial merge is a 200 that reports `added` and `skipped`, never an error (the guest cart
 * is a convenience, D4). It counts as one cart write against the rate limit.
 */
@Injectable()
export class MergeGuestCartCommand {
  constructor(
    private readonly carts: CartRepository,
    private readonly eligibility: PurchaseEligibilityChecker,
    private readonly quotes: CartQuoteService,
    private readonly limiter: CommerceRateLimiter,
    private readonly tx: TransactionRunner,
    private readonly settings: CommerceSettings,
  ) {}

  async execute(input: MergeGuestCartInput): Promise<MergeGuestCartResponse> {
    await this.limiter.hitCartWrite(input.userId);
    return this.tx.run(async (trx) => {
      await this.carts.lockCart(trx, input.userId);
      const items = new Set(await this.carts.listCourseIds(input.userId, trx));
      const ids = [...new Set(input.courseIds)].filter((id) => !items.has(id));
      const reasons = await this.eligibility.check(input.userId, ids, trx);
      const added: string[] = [];
      const skipped: { courseId: string; reason: MergeSkipReason }[] = [];
      let count = items.size;
      for (const courseId of ids) {
        const reason = reasons.get(courseId) ?? null;
        if (reason !== null) {
          skipped.push({ courseId, reason });
        } else if (count >= this.settings.cartMaxItems) {
          skipped.push({ courseId, reason: ErrorCode.CartFull });
        } else {
          if (await this.carts.addItem(trx, input.userId, courseId)) {
            added.push(courseId);
            count += 1;
          }
        }
      }
      const quote = (await this.quotes.price(input.userId, trx)).view;
      return { quote, added, skipped };
    });
  }
}
