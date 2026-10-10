import {
  type Currency,
  CurrencySchema,
  MAX_MONEY_MINOR,
  type MoneyAmount,
  minorToMoney,
  moneyToMinor,
  percentOfMinor,
} from '@udemy/contracts';

/** Two `Money` values of different currencies were combined (a programming error, 500). */
export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Cannot combine ${a} and ${b} amounts`);
    this.name = new.target.name;
  }
}

/**
 * An amount of money in **integer minor units** (cents) of an allow-listed currency (design D3).
 *
 * - I/O is the canonical decimal string (`"19.99"`), exactly what `numeric(12,2)` gives back
 *   through Kysely; `fromDecimal` refuses anything else (floats, `"19.9"`, `"-1.00"`, `"1e3"`).
 * - Arithmetic never leaves the integers: sums, floored differences and half-up percentages.
 * - Values are never negative; `minusFloored` floors at 0 (an AMOUNT coupon never makes a price
 *   negative, D5).
 *
 * The DB stays the rounding authority for coupon discounts (`commerce.coupon_discount`) and
 * revenue shares (generated columns); this VO is property-tested to agree with both rules.
 */
export class Money {
  private constructor(
    /** Safe, non-negative integer of minor units. */
    readonly minor: number,
    readonly currency: Currency,
  ) {}

  /** @throws RangeError for a non-canonical amount or a currency outside the allowlist */
  static fromDecimal(amount: string, currency: string): Money {
    return new Money(moneyToMinor(amount), Money.currencyOf(currency));
  }

  /** @throws RangeError for a negative, fractional or out-of-range minor amount */
  static ofMinor(minor: number, currency: string): Money {
    if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_MONEY_MINOR) {
      throw new RangeError(`Not a valid minor-unit amount: ${minor}`);
    }
    return new Money(minor, Money.currencyOf(currency));
  }

  static zero(currency: string): Money {
    return new Money(0, Money.currencyOf(currency));
  }

  /** Sum of `amounts` (all in `currency`); zero for an empty list. */
  static sum(amounts: readonly Money[], currency: string): Money {
    return amounts.reduce((total, amount) => total.add(amount), Money.zero(currency));
  }

  private static currencyOf(currency: string): Currency {
    const parsed = CurrencySchema.safeParse(currency);
    if (!parsed.success) throw new RangeError(`Currency not allowed: ${JSON.stringify(currency)}`);
    return parsed.data;
  }

  /** The canonical decimal string, e.g. `"19.99"`. */
  toDecimal(): MoneyAmount {
    return minorToMoney(this.minor);
  }

  isZero(): boolean {
    return this.minor === 0;
  }

  isPositive(): boolean {
    return this.minor > 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** -1, 0 or 1. @throws CurrencyMismatchError */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }

  /** @throws CurrencyMismatchError */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor + other.minor, this.currency);
  }

  /** `this - other`, floored at 0. @throws CurrencyMismatchError */
  minusFloored(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(Math.max(0, this.minor - other.minor), this.currency);
  }

  /** The smaller of the two. @throws CurrencyMismatchError */
  min(other: Money): Money {
    return this.compare(other) <= 0 ? this : other;
  }

  /**
   * `percent`% of this amount, rounded **half up** to the minor unit (D3):
   * `round_half_up(minor × percent / 100)`. `percent` is an integer 0–100.
   */
  percentOf(percent: number): Money {
    return new Money(percentOfMinor(this.minor, percent), this.currency);
  }

  /** `{ amount, currency }`, the contracts `MoneySchema` shape. */
  toJSON(): { amount: MoneyAmount; currency: Currency } {
    return { amount: this.toDecimal(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
