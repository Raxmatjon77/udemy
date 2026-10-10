import { z } from 'zod';

/**
 * Money at the boundary (Phase 4 design D3, §7): a **decimal string** with exactly two
 * fraction digits, never a JS float. PostgreSQL `numeric(12,2)` (what Kysely returns as a
 * string) has at most 10 integer digits, which is the bound below.
 *
 * Arithmetic happens in **integer minor units** (cents). The helpers here are pure and exact
 * for every value the schema accepts (≤ 9,999,999,999.99 = 999,999,999,999 minor units, well
 * inside `Number.MAX_SAFE_INTEGER`). The api `Money` value object stays authoritative; these
 * exist so the three web apps can preview totals ("students pay X") without floats.
 */

/**
 * Canonical form only: no sign, no leading zeros (`0.50`, not `00.50`), exactly two decimals.
 * This is the form `numeric(12,2)::text` produces, so string equality is value equality.
 */
export const MONEY_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;

export const MoneyAmountSchema = z
  .string()
  .regex(MONEY_AMOUNT_PATTERN, 'Must be a decimal amount with two decimals, e.g. 19.99')
  .meta({
    description: 'Decimal amount with exactly two fraction digits (never a float).',
    examples: ['19.99', '0.00'],
  });
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;

/**
 * A signed money amount (P4-T16): the canonical form with an optional leading `-` (never
 * `-0.00`). Only for derived report figures that can go below zero, e.g. a sales range whose
 * refunds belong to earlier sales; stored amounts and charges are always `MoneyAmount`.
 */
export const SIGNED_MONEY_AMOUNT_PATTERN =
  /^(?:0\.\d{2}|-?(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d{0,9}\.\d{2}))$/;

export const SignedMoneyAmountSchema = z
  .string()
  .regex(SIGNED_MONEY_AMOUNT_PATTERN, 'Must be a decimal amount with two decimals, e.g. -4.99')
  .meta({
    description: 'Signed decimal amount with exactly two fraction digits (never a float).',
    examples: ['13.99', '-4.99', '0.00'],
  });
export type SignedMoneyAmount = z.infer<typeof SignedMoneyAmountSchema>;

/**
 * The currency allowlist (ISO 4217, 2-decimal currencies only). The DB accepts any
 * `^[A-Z]{3}$`; the platform currency is `COMMERCE_CURRENCY` (USD in Phase 4, §13 Q4).
 */
export const CURRENCIES = ['USD'] as const;
export const CurrencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof CurrencySchema>;

/** The platform currency until multi-currency lands (§13 Q4). */
export const DEFAULT_CURRENCY: Currency = 'USD';

/** Fraction digits per allowed currency (every allowed currency has 2). */
export const CURRENCY_MINOR_DIGITS: Readonly<Record<Currency, 2>> = Object.freeze({ USD: 2 });

/** `{ amount, currency }`, as the api serialises a `Money` value. */
export const MoneySchema = z.object({ amount: MoneyAmountSchema, currency: CurrencySchema });
export type Money = z.infer<typeof MoneySchema>;

/** The zero amount; also the price of a free course (D14). */
export const ZERO_AMOUNT = '0.00';

/**
 * Stripe's minimum charge: an order total in (0, 0.50) is rejected with
 * `amount_below_minimum` (D3). A total of exactly 0.00 is the zero-total path (D14).
 */
export const MIN_CHARGE_AMOUNT = '0.50';
export const MIN_CHARGE_MINOR = 50;

/** `course_prices.amount <= 9999.99` (design §6). */
export const MAX_PRICE_AMOUNT = '9999.99';

/** Largest amount the schema accepts, in minor units. */
export const MAX_MONEY_MINOR = 999_999_999_999;

export function isMoneyAmount(value: unknown): value is MoneyAmount {
  return typeof value === 'string' && MONEY_AMOUNT_PATTERN.test(value);
}

/**
 * `"19.99"` → `1999`. Throws a `RangeError` for anything that is not a canonical amount
 * (floats, `"19.9"`, `"-1.00"`, `"1e3"`, `"019.99"`): parsing never guesses.
 */
export function moneyToMinor(amount: string): number {
  if (!isMoneyAmount(amount)) {
    throw new RangeError(`Not a canonical money amount: ${JSON.stringify(amount)}`);
  }
  const [units = '0', cents = '00'] = amount.split('.');
  return Number(units) * 100 + Number(cents);
}

/** `1999` → `"19.99"`. Throws a `RangeError` for negative, fractional or out-of-range input. */
export function minorToMoney(minor: number): MoneyAmount {
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_MONEY_MINOR) {
    throw new RangeError(`Not a valid minor-unit amount: ${minor}`);
  }
  const units = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${units}.${String(cents).padStart(2, '0')}`;
}

/** Sum of amounts (exact). */
export function sumMoney(amounts: readonly string[]): MoneyAmount {
  return minorToMoney(amounts.reduce((total, amount) => total + moneyToMinor(amount), 0));
}

/** `a - b`, floored at 0 (an AMOUNT coupon never makes a price negative, D5). */
export function subtractMoneyFloored(a: string, b: string): MoneyAmount {
  return minorToMoney(Math.max(0, moneyToMinor(a) - moneyToMinor(b)));
}

/** -1, 0 or 1. */
export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const diff = moneyToMinor(a) - moneyToMinor(b);
  return diff < 0 ? -1 : diff > 0 ? 1 : 0;
}

/**
 * Percent discount in minor units, rounded **half up** (D3):
 * `round_half_up(listMinor × percent / 100)`. Integer math only.
 */
export function percentOfMinor(listMinor: number, percent: number): number {
  if (!Number.isSafeInteger(listMinor) || listMinor < 0) {
    throw new RangeError(`Not a valid minor-unit amount: ${listMinor}`);
  }
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`Percent must be an integer in 0–100, got ${percent}`);
  }
  return Math.floor((listMinor * percent + 50) / 100);
}

/** Coupon terms as far as the discount is concerned (D5). */
export type DiscountTerms =
  { discountType: 'PERCENT'; percentOff: number } | { discountType: 'AMOUNT'; amountOff: string };

/**
 * The discount a coupon gives on a list price, as a decimal string: PERCENT is rounded half
 * up, AMOUNT is capped at the list price. Mirrors the api `CouponTerms.discountFor`.
 */
export function discountFor(listAmount: string, terms: DiscountTerms): MoneyAmount {
  const listMinor = moneyToMinor(listAmount);
  const discountMinor =
    terms.discountType === 'PERCENT'
      ? percentOfMinor(listMinor, terms.percentOff)
      : Math.min(listMinor, moneyToMinor(terms.amountOff));
  return minorToMoney(discountMinor);
}

/** What the buyer pays for one line after a coupon: list − discount (never negative). */
export function priceAfterDiscount(listAmount: string, terms: DiscountTerms): MoneyAmount {
  return subtractMoneyFloored(listAmount, discountFor(listAmount, terms));
}

/**
 * Locale-aware display, e.g. `formatMoney('19.99', 'USD', 'en-US')` → `$19.99`.
 * The decimal string goes to `Intl.NumberFormat` as a string (exact decimal, ES2023), so no
 * float conversion ever happens. `locale` defaults to the runtime default.
 */
export function formatMoney(amount: string, currency: Currency, locale?: string): string {
  if (!isMoneyAmount(amount)) {
    throw new RangeError(`Not a canonical money amount: ${JSON.stringify(amount)}`);
  }
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: CURRENCY_MINOR_DIGITS[currency],
    maximumFractionDigits: CURRENCY_MINOR_DIGITS[currency],
  });
  return format.format(amount as Intl.StringNumericLiteral);
}
