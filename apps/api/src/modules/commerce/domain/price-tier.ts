import { type Currency, isMoneyAmount, PRICE_TIERS } from '@udemy/contracts';
import { PriceNotAllowed } from './commerce.errors';
import { Money } from './money';

/**
 * A course price that is one of the code-defined tiers (design D2): FREE (0.00) or a paid tier
 * of the platform currency. The DB stores only `amount` + `currency`; the tier is derived.
 */
export class PriceTier {
  private constructor(readonly price: Money) {}

  /** @throws PriceNotAllowed (422 `price_not_allowed`) for an amount outside `PRICE_TIERS[currency]` */
  static of(amount: string, currency: Currency): PriceTier {
    if (!isMoneyAmount(amount) || !PRICE_TIERS[currency].includes(amount)) {
      throw new PriceNotAllowed();
    }
    return new PriceTier(Money.fromDecimal(amount, currency));
  }

  get isFree(): boolean {
    return this.price.isZero();
  }
}
