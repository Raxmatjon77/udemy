import { Injectable } from '@nestjs/common';
import type { CartQuote } from '@udemy/contracts';
import { CartQuoteService } from '../cart-quote.service';
import { CartRepository } from '../ports/cart.repository';
import { TransactionRunner } from '../ports/transaction-runner';

/** `RemoveFromCart` (design §5): idempotent delete, then the fresh quote. */
@Injectable()
export class RemoveFromCartCommand {
  constructor(
    private readonly carts: CartRepository,
    private readonly quotes: CartQuoteService,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: { readonly userId: string; readonly courseId: string }): Promise<CartQuote> {
    return this.tx.run(async (trx) => {
      await this.carts.removeItem(input.userId, input.courseId, trx);
      return (await this.quotes.price(input.userId, trx)).view;
    });
  }
}
