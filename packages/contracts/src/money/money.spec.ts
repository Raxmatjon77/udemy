import { describe, expect, it } from 'vitest';
import {
  compareMoney,
  CurrencySchema,
  discountFor,
  formatMoney,
  isMoneyAmount,
  MAX_MONEY_MINOR,
  MIN_CHARGE_AMOUNT,
  MIN_CHARGE_MINOR,
  minorToMoney,
  MoneyAmountSchema,
  moneyToMinor,
  percentOfMinor,
  priceAfterDiscount,
  subtractMoneyFloored,
  sumMoney,
} from './money';
import {
  FREE_PRICE_AMOUNT,
  isFreeAmount,
  isPriceTier,
  PAID_PRICE_RANGE,
  PRICE_TIERS,
  PriceTierSchema,
} from './price-tiers';

describe('MoneyAmountSchema', () => {
  it.each(['0.00', '0.50', '19.99', '9999.99', '1234567890.12'])('accepts %s', (amount) => {
    expect(MoneyAmountSchema.safeParse(amount).success).toBe(true);
    expect(isMoneyAmount(amount)).toBe(true);
  });

  it.each([
    '19.9',
    '19',
    '19.999',
    '.99',
    '-1.00',
    '+1.00',
    '019.99',
    '00.00',
    '1e3',
    ' 19.99',
    '19.99 ',
    '19,99',
    '12345678901.00',
    '',
    'NaN',
  ])('rejects %j', (amount) => {
    expect(MoneyAmountSchema.safeParse(amount).success).toBe(false);
    expect(isMoneyAmount(amount)).toBe(false);
  });

  it('never accepts a number', () => {
    expect(MoneyAmountSchema.safeParse(19.99).success).toBe(false);
    expect(isMoneyAmount(0)).toBe(false);
  });

  it('allows USD only', () => {
    expect(CurrencySchema.options).toEqual(['USD']);
    expect(CurrencySchema.safeParse('EUR').success).toBe(false);
    expect(CurrencySchema.safeParse('usd').success).toBe(false);
  });
});

describe('minor-unit helpers', () => {
  it('parses exactly, without float error', () => {
    expect(moneyToMinor('0.00')).toBe(0);
    expect(moneyToMinor('0.01')).toBe(1);
    expect(moneyToMinor('19.99')).toBe(1999);
    expect(moneyToMinor('0.29')).toBe(29); // 0.29 * 100 = 28.999999999999996 as a float
    expect(moneyToMinor('1.10')).toBe(110);
    expect(moneyToMinor('9999999999.99')).toBe(MAX_MONEY_MINOR);
    expect(moneyToMinor(MIN_CHARGE_AMOUNT)).toBe(MIN_CHARGE_MINOR);
  });

  it('refuses to guess on malformed input', () => {
    for (const bad of ['19.9', '-0.01', '1e2', '19.999', '']) {
      expect(() => moneyToMinor(bad), bad).toThrow(RangeError);
    }
  });

  it('formats minor units back to canonical strings', () => {
    expect(minorToMoney(0)).toBe('0.00');
    expect(minorToMoney(5)).toBe('0.05');
    expect(minorToMoney(50)).toBe('0.50');
    expect(minorToMoney(1999)).toBe('19.99');
    expect(minorToMoney(100_000)).toBe('1000.00');
    expect(minorToMoney(MAX_MONEY_MINOR)).toBe('9999999999.99');
    for (const bad of [-1, 1.5, Number.NaN, MAX_MONEY_MINOR + 1]) {
      expect(() => minorToMoney(bad), String(bad)).toThrow(RangeError);
    }
  });

  it('round-trips every cent of the first 100 dollars', () => {
    for (let minor = 0; minor <= 10_000; minor += 1) {
      expect(moneyToMinor(minorToMoney(minor))).toBe(minor);
    }
  });

  it('adds, subtracts (floored) and compares exactly', () => {
    expect(sumMoney([])).toBe('0.00');
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30'); // 0.1 + 0.2 = 0.30000000000000004 as floats
    expect(sumMoney(['19.99', '24.99', '199.99'])).toBe('244.97');
    expect(subtractMoneyFloored('19.99', '5.00')).toBe('14.99');
    expect(subtractMoneyFloored('19.99', '25.00')).toBe('0.00');
    expect(compareMoney('19.99', '19.99')).toBe(0);
    expect(compareMoney('9.99', '19.99')).toBe(-1);
    expect(compareMoney('100.00', '99.99')).toBe(1);
  });

  it('rounds percent discounts half up (D3)', () => {
    expect(percentOfMinor(1999, 50)).toBe(1000); // 999.5 -> 1000
    expect(percentOfMinor(1999, 10)).toBe(200); // 199.9 -> 200
    expect(percentOfMinor(2499, 15)).toBe(375); // 374.85 -> 375
    expect(percentOfMinor(1001, 50)).toBe(501); // 500.5 -> 501
    expect(percentOfMinor(1999, 0)).toBe(0);
    expect(percentOfMinor(1999, 100)).toBe(1999);
    expect(() => percentOfMinor(1999, 101)).toThrow(RangeError);
    expect(() => percentOfMinor(1999, 12.5)).toThrow(RangeError);
    expect(() => percentOfMinor(-1, 10)).toThrow(RangeError);
  });

  it('computes coupon discounts and final prices like CouponTerms', () => {
    expect(discountFor('19.99', { discountType: 'PERCENT', percentOff: 50 })).toBe('10.00');
    expect(priceAfterDiscount('19.99', { discountType: 'PERCENT', percentOff: 50 })).toBe('9.99');
    expect(priceAfterDiscount('19.99', { discountType: 'PERCENT', percentOff: 100 })).toBe('0.00');
    expect(discountFor('19.99', { discountType: 'AMOUNT', amountOff: '5.00' })).toBe('5.00');
    expect(discountFor('19.99', { discountType: 'AMOUNT', amountOff: '50.00' })).toBe('19.99');
    expect(priceAfterDiscount('19.99', { discountType: 'AMOUNT', amountOff: '50.00' })).toBe(
      '0.00',
    );
  });
});

describe('formatMoney', () => {
  it('formats with the locale and two decimals', () => {
    expect(formatMoney('19.99', 'USD', 'en-US')).toBe('$19.99');
    expect(formatMoney('0.00', 'USD', 'en-US')).toBe('$0.00');
    expect(formatMoney('1234.50', 'USD', 'en-US')).toBe('$1,234.50');
    // de-DE uses a comma decimal separator and a trailing symbol (with a no-break space)
    expect(formatMoney('1234.50', 'USD', 'de-DE').replace(/\s/g, ' ')).toBe('1.234,50 $');
  });

  it('keeps every digit of large amounts (no float conversion)', () => {
    expect(formatMoney('9999999999.99', 'USD', 'en-US')).toBe('$9,999,999,999.99');
  });

  it('rejects non-canonical amounts', () => {
    expect(() => formatMoney('19.9', 'USD', 'en-US')).toThrow(RangeError);
    expect(() => formatMoney(19.99 as unknown as string, 'USD', 'en-US')).toThrow(RangeError);
  });
});

describe('PRICE_TIERS (D2)', () => {
  const usd = PRICE_TIERS.USD;

  it('is FREE plus the 19.99–199.99 tiers', () => {
    expect(usd[0]).toBe(FREE_PRICE_AMOUNT);
    expect(usd).toHaveLength(25);
    expect(usd.slice(1, 18)).toEqual(
      Array.from({ length: 17 }, (_, i) => minorToMoney(1999 + i * 500)),
    );
    expect(usd.slice(18, 23)).toEqual(['109.99', '119.99', '129.99', '139.99', '149.99']);
    expect(usd.slice(23)).toEqual(['174.99', '199.99']);
    expect(PAID_PRICE_RANGE.USD).toEqual({ min: usd[1], max: usd.at(-1) });
  });

  it('is ascending, unique, canonical and frozen', () => {
    for (const amount of usd) expect(isMoneyAmount(amount), amount).toBe(true);
    const minor = usd.map(moneyToMinor);
    expect([...minor].sort((a, b) => a - b)).toEqual(minor);
    expect(new Set(minor).size).toBe(minor.length);
    expect(Object.isFrozen(usd)).toBe(true);
    expect(Object.isFrozen(PRICE_TIERS)).toBe(true);
  });

  it('validates tier membership', () => {
    expect(isPriceTier('19.99', 'USD')).toBe(true);
    expect(isPriceTier('0.00', 'USD')).toBe(true);
    expect(isPriceTier('13.37', 'USD')).toBe(false);
    expect(isPriceTier('104.99', 'USD')).toBe(false);
    expect(isFreeAmount('0.00')).toBe(true);
    expect(isFreeAmount('19.99')).toBe(false);
    expect(PriceTierSchema.safeParse({ amount: '24.99', currency: 'USD' }).success).toBe(true);
    expect(PriceTierSchema.safeParse({ amount: '25.00', currency: 'USD' }).success).toBe(false);
    expect(PriceTierSchema.safeParse({ amount: '24.99', currency: 'EUR' }).success).toBe(false);
  });
});
