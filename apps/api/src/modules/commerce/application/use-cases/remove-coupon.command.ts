import { Injectable } from '@nestjs/common';
import type { CartQuote } from '@udemy/contracts';
import { CartQuoteService } from '../cart-quote.service';
import { CartRepository } from '../ports/cart.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/** `RemoveCoupon` (design §5): clears the cart's code (idempotent), then the fresh quote. */
@Injectable()
export class RemoveCouponCommand {
  constructor(
    private readonly carts: CartRepository,
    private readonly quotes: CartQuoteService,
    private readonly tx: TransactionRunner,
  ) {}

  execute(userId: string): Promise<CartQuote> {
    return this.tx.run(async (trx) => {
      await this.carts.lockCart(trx, userId);
      await this.carts.setCouponCode(trx, userId, null);
      return (await this.quotes.price(userId, trx)).view;
    });
  }
}
