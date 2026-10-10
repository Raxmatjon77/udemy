import { CART_LIMITS, type Currency, DEFAULT_CURRENCY } from '@udemy/contracts';

export interface CommerceSettingsProps {
  /** `COMMERCE_CURRENCY`: the single platform currency (§13 Q4: USD). */
  readonly currency: Currency;
  /** `COMMERCE_CART_MAX_ITEMS` (D4: 20). */
  readonly cartMaxItems: number;
}

/**
 * Commerce configuration. P4-T13 binds the contract defaults (`DEFAULT_CURRENCY`,
 * `CART_LIMITS.maxItems`); P4-T15 adds the `COMMERCE_*` env schema and binds this class from
 * it (`{ provide: CommerceSettings, useFactory: commerceSettingsFrom(config) }`), together with
 * the checkout-only settings (session TTL, refund window, revenue share).
 */
export class CommerceSettings {
  readonly currency: Currency;
  readonly cartMaxItems: number;

  constructor(props: CommerceSettingsProps) {
    if (!Number.isSafeInteger(props.cartMaxItems) || props.cartMaxItems < 1) {
      throw new RangeError('cartMaxItems must be a positive integer');
    }
    if (props.cartMaxItems > CART_LIMITS.maxItems) {
      // CartQuoteSchema caps lines at CART_LIMITS.maxItems; a bigger cart breaks the contract.
      throw new RangeError(`cartMaxItems must be at most ${CART_LIMITS.maxItems}`);
    }
    this.currency = props.currency;
    this.cartMaxItems = props.cartMaxItems;
  }

  static defaults(): CommerceSettings {
    return new CommerceSettings({ currency: DEFAULT_CURRENCY, cartMaxItems: CART_LIMITS.maxItems });
  }
}
