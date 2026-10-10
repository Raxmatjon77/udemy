import { z } from 'zod';
import { type Currency, CurrencySchema, MONEY_AMOUNT_PATTERN, ZERO_AMOUNT } from './money';

/**
 * Code-defined price tiers (Phase 4 design D2, §13 Q5): FREE (0.00), then
 * 19.99 … 99.99 in 5.00 steps, 109.99 … 149.99 in 10.00 steps, 174.99 and 199.99.
 * The DB stores only `amount` + `currency`; the tier is derived. A price outside the list is
 * 422 `price_not_allowed` (the api's `PriceTier` VO is authoritative).
 */
export const FREE_PRICE_AMOUNT = ZERO_AMOUNT;

export const PRICE_TIERS: Readonly<Record<Currency, readonly string[]>> = Object.freeze({
  USD: Object.freeze([
    FREE_PRICE_AMOUNT,
    '19.99',
    '24.99',
    '29.99',
    '34.99',
    '39.99',
    '44.99',
    '49.99',
    '54.99',
    '59.99',
    '64.99',
    '69.99',
    '74.99',
    '79.99',
    '84.99',
    '89.99',
    '94.99',
    '99.99',
    '109.99',
    '119.99',
    '129.99',
    '139.99',
    '149.99',
    '174.99',
    '199.99',
  ]),
});

/** Lowest and highest paid tier per currency (D2). */
export const PAID_PRICE_RANGE: Readonly<Record<Currency, { min: string; max: string }>> =
  Object.freeze({ USD: Object.freeze({ min: '19.99', max: '199.99' }) });

export function isPriceTier(amount: string, currency: Currency): boolean {
  return PRICE_TIERS[currency].includes(amount);
}

export function isFreeAmount(amount: string): boolean {
  return amount === FREE_PRICE_AMOUNT;
}

/**
 * A `{ amount, currency }` that is one of the tiers. For forms (the tier `<select>`); the
 * `PUT /courses/:courseId/pricing` request only checks the decimal format, so an off-tier
 * amount gets the stable 422 `price_not_allowed` from the api instead of a 400.
 */
export const PriceTierSchema = z
  .object({ amount: z.string().regex(MONEY_AMOUNT_PATTERN), currency: CurrencySchema })
  .refine((price) => isPriceTier(price.amount, price.currency), {
    message: 'Not an allowed price tier',
    path: ['amount'],
  });
export type PriceTier = z.infer<typeof PriceTierSchema>;
