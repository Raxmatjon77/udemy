import { Injectable } from '@nestjs/common';
import type { CartQuote } from '@udemy/contracts';
import { CartQuoteService } from '../cart-quote.service';
import { TransactionRunner } from '../ports/transaction-runner';

/**
 * `GetCart` (= the quote, design §5): current prices, the best coupon per line, totals,
 * `unavailable[]` with reasons and the fingerprint. Read-only, but in one transaction so the
 * quote statements share `now()`; it takes no lock (an empty cart needs no cart row).
 */
@Injectable()
export class GetCartQuery {
  constructor(
    private readonly quotes: CartQuoteService,
    private readonly tx: TransactionRunner,
  ) {}

  execute(userId: string): Promise<CartQuote> {
    return this.tx.run(async (trx) => (await this.quotes.price(userId, trx)).view);
  }
}
