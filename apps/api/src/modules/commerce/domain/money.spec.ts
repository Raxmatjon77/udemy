import { discountFor, MAX_MONEY_MINOR, minorToMoney, PRICE_TIERS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { CouponTerms } from './coupon-terms';
import { CurrencyMismatchError, Money } from './money';
import { prng } from './testing/prng';

const RUNS = 5_000;

/** Exact reference for half-up rounding with BigInt: round(minor × p / 100), .5 away from 0. */
function halfUpReference(minor: number, percent: number): number {
  const scaled = BigInt(minor) * BigInt(percent);
  const quotient = scaled / 100n;
  const remainder = scaled % 100n;
  return Number(remainder * 2n >= 100n ? quotient + 1n : quotient);
}

describe('Money', () => {
  it('parses canonical decimal strings exactly and round-trips them', () => {
    expect(Money.fromDecimal('0.29', 'USD').minor).toBe(29);
    expect(Money.fromDecimal('19.99', 'USD').toDecimal()).toBe('19.99');
    expect(Money.fromDecimal('9999.99', 'USD').minor).toBe(999_999);
    expect(Money.ofMinor(5, 'USD').toDecimal()).toBe('0.05');
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });

  it('never accepts floats, signs, exponents or non-canonical forms', () => {
    for (const bad of ['19.9', '-1.00', '1e3', '019.99', '19.999', '', ' 1.00']) {
      expect(() => Money.fromDecimal(bad, 'USD'), bad).toThrow(RangeError);
    }
    expect(() => Money.fromDecimal(19.99 as unknown as string, 'USD')).toThrow(RangeError);
    expect(() => Money.ofMinor(-1, 'USD')).toThrow(RangeError);
    expect(() => Money.ofMinor(1.5, 'USD')).toThrow(RangeError);
    expect(() => Money.ofMinor(MAX_MONEY_MINOR + 1, 'USD')).toThrow(RangeError);
  });

  it('allows only allow-listed currencies and never mixes them', () => {
    expect(() => Money.fromDecimal('1.00', 'EUR')).toThrow(RangeError);
    expect(() => Money.fromDecimal('1.00', 'usd')).toThrow(RangeError);
    const usd = Money.fromDecimal('1.00', 'USD');
    // Only USD is allowed in Phase 4, so a foreign value has to be forged for the check.
    const forged = Object.assign(Object.create(Money.prototype) as Money, {
      minor: 100,
      currency: 'EUR',
    });
    expect(() => usd.add(forged)).toThrow(CurrencyMismatchError);
    expect(() => usd.compare(forged)).toThrow(CurrencyMismatchError);
    expect(usd.equals(forged)).toBe(false);
  });

  it('adds, subtracts (floored at 0) and compares exactly where floats would not', () => {
    const a = Money.fromDecimal('0.10', 'USD');
    const b = Money.fromDecimal('0.20', 'USD');
    expect(a.add(b).toDecimal()).toBe('0.30');
    expect(Money.sum([a, b, b], 'USD').toDecimal()).toBe('0.50');
    expect(Money.sum([], 'USD').toDecimal()).toBe('0.00');
    expect(b.minusFloored(a).toDecimal()).toBe('0.10');
    expect(a.minusFloored(b).toDecimal()).toBe('0.00');
    expect(a.compare(b)).toBe(-1);
    expect(b.min(a)).toBe(a);
  });

  it('rounds percentages half up', () => {
    const list = Money.fromDecimal('19.99', 'USD');
    expect(list.percentOf(50).toDecimal()).toBe('10.00'); // 999.5 -> 1000
    expect(list.percentOf(10).toDecimal()).toBe('2.00'); // 199.9 -> 200
    expect(Money.fromDecimal('24.99', 'USD').percentOf(15).toDecimal()).toBe('3.75'); // 374.85
    expect(Money.fromDecimal('0.01', 'USD').percentOf(50).toDecimal()).toBe('0.01'); // 0.5 -> 1
    expect(Money.fromDecimal('0.01', 'USD').percentOf(49).toDecimal()).toBe('0.00'); // 0.49 -> 0
    expect(() => list.percentOf(101)).toThrow(RangeError);
    expect(() => list.percentOf(12.5)).toThrow(RangeError);
  });
});

describe('Money + CouponTerms: rounding properties (seeded, reproducible)', () => {
  const percentCoupon = (percentOff: number): CouponTerms =>
    CouponTerms.of({
      id: '00000000-0000-7000-8000-000000000001',
      scope: 'PLATFORM',
      courseId: null,
      discount: { type: 'PERCENT', percentOff },
    });
  const amountCoupon = (amountOff: Money): CouponTerms =>
    CouponTerms.of({
      id: '00000000-0000-7000-8000-000000000002',
      scope: 'COURSE',
      courseId: '00000000-0000-7000-8000-0000000000aa',
      discount: { type: 'AMOUNT', amountOff },
    });

  it('PERCENT: half-up equals the exact BigInt reference for every generated case', () => {
    const r = prng(0xc0ffee);
    for (let i = 0; i < RUNS; i++) {
      const minor = r.int(0, 999_999); // numeric(12,2) course prices are <= 9999.99
      const percent = r.int(1, 100);
      const list = Money.ofMinor(minor, 'USD');
      const discount = percentCoupon(percent).discountFor(list);
      expect(discount?.minor, `${minor}×${percent}%`).toBe(halfUpReference(minor, percent));
    }
  });

  it('PERCENT: every .xx5 boundary rounds up, and the result is exact at 1/33/50/100%', () => {
    // minor × p / 100 has a fractional part of exactly .5 iff (minor × p) mod 100 = 50.
    for (let minor = 1; minor <= 20_000; minor++) {
      for (const p of [1, 33, 50, 100]) {
        const d = Money.ofMinor(minor, 'USD').percentOf(p).minor;
        const twice = minor * p * 2;
        // |d - x| <= 0.5 with ties going up: 200d - 2·minor·p is in (-100, 100].
        expect(d * 200 > twice - 100 && d * 200 <= twice + 100, `${minor}×${p}`).toBe(true);
        if ((minor * p) % 100 === 50) expect(d).toBe((minor * p + 50) / 100);
      }
    }
  });

  it('discount + final == list, discount <= list and nothing is ever negative', () => {
    const r = prng(42);
    for (let i = 0; i < RUNS; i++) {
      const list = Money.ofMinor(r.int(0, 999_999), 'USD');
      const terms = r.bool()
        ? percentCoupon(r.int(1, 100))
        : amountCoupon(Money.ofMinor(r.int(1, 1_200_000), 'USD'));
      const discount = terms.discountFor(list);
      if (discount === null) throw new Error('same-currency coupon must apply');
      const final = list.minusFloored(discount);
      expect(discount.add(final).equals(list), `${list} - ${discount}`).toBe(true);
      expect(discount.compare(list)).toBeLessThanOrEqual(0);
      expect(discount.minor).toBeGreaterThanOrEqual(0);
      expect(final.minor).toBeGreaterThanOrEqual(0);
    }
  });

  it('AMOUNT is capped at the list price (a 100% / over-sized coupon makes the line free)', () => {
    const r = prng(7);
    for (let i = 0; i < RUNS; i++) {
      const list = Money.ofMinor(r.int(0, 999_999), 'USD');
      const off = Money.ofMinor(r.int(1, 1_200_000), 'USD');
      const discount = amountCoupon(off).discountFor(list);
      expect(discount?.minor).toBe(Math.min(off.minor, list.minor));
      if (off.compare(list) >= 0) expect(list.minusFloored(off).isZero()).toBe(true);
    }
    expect(percentCoupon(100).discountFor(Money.fromDecimal('199.99', 'USD'))?.toDecimal()).toBe(
      '199.99',
    );
  });

  it('agrees with the contracts preview helper (the web apps show the same "students pay X")', () => {
    const r = prng(2024);
    for (let i = 0; i < RUNS; i++) {
      const list = Money.ofMinor(r.int(0, 999_999), 'USD');
      if (r.bool()) {
        const p = r.int(1, 100);
        expect(percentCoupon(p).discountFor(list)?.toDecimal()).toBe(
          discountFor(list.toDecimal(), { discountType: 'PERCENT', percentOff: p }),
        );
      } else {
        const off = Money.ofMinor(r.int(1, 1_200_000), 'USD');
        expect(amountCoupon(off).discountFor(list)?.toDecimal()).toBe(
          discountFor(list.toDecimal(), { discountType: 'AMOUNT', amountOff: off.toDecimal() }),
        );
      }
    }
  });

  it('sums of tier prices stay exact (no float drift over a full cart)', () => {
    const r = prng(99);
    const tiers = PRICE_TIERS.USD;
    for (let i = 0; i < 500; i++) {
      const picks = Array.from({ length: r.int(1, 20) }, () => r.pick(tiers));
      const total = Money.sum(
        picks.map((p) => Money.fromDecimal(p, 'USD')),
        'USD',
      );
      const reference = picks.reduce((s, p) => s + BigInt(p.replace('.', '')), 0n);
      expect(total.toDecimal()).toBe(minorToMoney(Number(reference)));
    }
  });
});
