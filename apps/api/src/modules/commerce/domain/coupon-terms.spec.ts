import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CouponCandidate,
  couponProblem,
  courseCouponIssues,
  CouponTerms,
  isRedeemable,
  platformCouponIssues,
  selectBestCoupon,
} from './coupon-terms';
import { Money } from './money';
import { prng } from './testing/prng';

const COURSE_A = '0190a000-0000-7000-8000-00000000000a';
const COURSE_B = '0190a000-0000-7000-8000-00000000000b';
const usd = (amount: string): Money => Money.fromDecimal(amount, 'USD');

let seq = 0;
function id(): string {
  seq += 1;
  return `0190b000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

function course(
  courseId: string,
  discount: { percentOff: number } | { amountOff: string },
  overrides: Partial<Omit<CouponCandidate, 'terms'>> & { id?: string } = {},
): CouponCandidate {
  return {
    terms: CouponTerms.of({
      id: overrides.id ?? id(),
      scope: 'COURSE',
      courseId,
      discount:
        'percentOff' in discount
          ? { type: 'PERCENT', percentOff: discount.percentOff }
          : { type: 'AMOUNT', amountOff: usd(discount.amountOff) },
    }),
    state: overrides.state ?? 'ACTIVE',
    usedByMe: overrides.usedByMe ?? false,
  };
}

function platform(
  percentOff: number,
  overrides: Partial<Omit<CouponCandidate, 'terms'>> & { id?: string } = {},
): CouponCandidate {
  return {
    terms: CouponTerms.of({
      id: overrides.id ?? id(),
      scope: 'PLATFORM',
      courseId: null,
      discount: { type: 'PERCENT', percentOff },
    }),
    state: overrides.state ?? 'ACTIVE',
    usedByMe: overrides.usedByMe ?? false,
  };
}

describe('CouponTerms', () => {
  it('enforces the coupons CHECKs', () => {
    const base = { id: id(), discount: { type: 'PERCENT' as const, percentOff: 10 } };
    expect(() => CouponTerms.of({ ...base, scope: 'COURSE', courseId: null })).toThrow(RangeError);
    expect(() => CouponTerms.of({ ...base, scope: 'PLATFORM', courseId: COURSE_A })).toThrow(
      RangeError,
    );
    for (const percentOff of [0, 101, 12.5]) {
      expect(() =>
        CouponTerms.of({
          id: id(),
          scope: 'PLATFORM',
          courseId: null,
          discount: { type: 'PERCENT', percentOff },
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      CouponTerms.of({
        id: id(),
        scope: 'PLATFORM',
        courseId: null,
        discount: { type: 'AMOUNT', amountOff: usd('5.00') },
      }),
    ).toThrow('PERCENT only');
    expect(() =>
      CouponTerms.of({
        id: id(),
        scope: 'COURSE',
        courseId: COURSE_A,
        discount: { type: 'AMOUNT', amountOff: usd('0.00') },
      }),
    ).toThrow(RangeError);
  });

  it('maps DB rows, including numeric strings', () => {
    const terms = CouponTerms.fromRow({
      id: id(),
      scope: 'COURSE',
      courseId: COURSE_A,
      discountType: 'AMOUNT',
      percentOff: null,
      amountOff: '5.00',
      currency: 'USD',
    });
    expect(terms.discountFor(usd('19.99'))?.toDecimal()).toBe('5.00');
    expect(terms.appliesTo(COURSE_A)).toBe(true);
    expect(terms.appliesTo(COURSE_B)).toBe(false);
    expect(() =>
      CouponTerms.fromRow({
        id: id(),
        scope: 'COURSE',
        courseId: COURSE_A,
        discountType: 'PERCENT',
        percentOff: null,
        amountOff: null,
        currency: null,
      }),
    ).toThrow('Malformed');
  });
});

describe('selectBestCoupon (best-of per line, D5)', () => {
  const line = { courseId: COURSE_A, list: usd('49.99') };

  it('picks the largest discount between the course and the platform coupon', () => {
    const c = course(COURSE_A, { percentOff: 20 }); // 10.00
    const p = platform(30); // 15.00
    expect(selectBestCoupon(line, [c, p])).toMatchObject({
      couponId: p.terms.id,
      scope: 'PLATFORM',
    });
    const big = course(COURSE_A, { amountOff: '20.00' });
    expect(selectBestCoupon(line, [big, p])?.couponId).toBe(big.terms.id);
  });

  it('breaks a tie in favour of the course coupon, whatever the ids', () => {
    // 50% of 49.99 = 25.00 (half up) and AMOUNT 25.00 give the same discount.
    const p = platform(50, { id: '0190b000-0000-7000-8000-000000000000' }); // lowest id
    const c = course(
      COURSE_A,
      { amountOff: '25.00' },
      { id: '0190b000-0000-7000-8000-ffffffffffff' },
    );
    const best = selectBestCoupon(line, [p, c]);
    expect(best).toMatchObject({ couponId: c.terms.id, scope: 'COURSE' });
    expect(best?.discount.toDecimal()).toBe('25.00');
    // Two equal course coupons (not possible for one code, but defined): lowest id.
    const c2 = course(
      COURSE_A,
      { amountOff: '25.00' },
      { id: '0190b000-0000-7000-8000-000000000001' },
    );
    expect(selectBestCoupon(line, [c, c2])?.couponId).toBe(c2.terms.id);
  });

  it('ignores coupons of other courses, unredeemable ones and free lines', () => {
    expect(selectBestCoupon(line, [course(COURSE_B, { percentOff: 90 })])).toBeNull();
    for (const state of ['SCHEDULED', 'EXPIRED', 'EXHAUSTED', 'DEACTIVATED'] as const) {
      expect(selectBestCoupon(line, [platform(90, { state })]), state).toBeNull();
    }
    const used = platform(90, { usedByMe: true });
    expect(isRedeemable(used)).toBe(false);
    expect(selectBestCoupon(line, [used])).toBeNull();
    expect(selectBestCoupon({ courseId: COURSE_A, list: usd('0.00') }, [platform(50)])).toBeNull();
  });

  it('property: the pick is a maximum, never stacks, and never exceeds the list price', () => {
    const r = prng(1234);
    for (let i = 0; i < 2_000; i++) {
      const list = Money.ofMinor(r.int(1, 999_999), 'USD');
      const candidates = Array.from({ length: r.int(0, 4) }, () =>
        r.bool()
          ? platform(r.int(1, 100), { state: r.pick(['ACTIVE', 'ACTIVE', 'EXPIRED'] as const) })
          : course(r.pick([COURSE_A, COURSE_B]), {
              amountOff: Money.ofMinor(r.int(1, 1_000_000), 'USD').toDecimal(),
            }),
      );
      const best = selectBestCoupon({ courseId: COURSE_A, list }, candidates);
      const options = candidates
        .filter((c) => isRedeemable(c) && c.terms.appliesTo(COURSE_A))
        .map((c) => c.terms.discountFor(list)?.minor ?? -1);
      if (options.length === 0) {
        expect(best).toBeNull();
        continue;
      }
      expect(best?.discount.minor).toBe(Math.max(...options));
      expect(best?.discount.compare(list)).toBeLessThanOrEqual(0);
    }
  });
});

describe('couponProblem (§9: specific errors only for a code that matches the cart)', () => {
  it('is coupon_invalid without a candidate for a purchasable line', () => {
    expect(couponProblem([], [COURSE_A])).toBe(ErrorCode.CouponInvalid);
    expect(
      couponProblem([course(COURSE_B, { percentOff: 10 }, { state: 'EXPIRED' })], [COURSE_A]),
    ).toBe(ErrorCode.CouponInvalid);
    // A platform coupon needs at least one purchasable line.
    expect(couponProblem([platform(10, { state: 'EXPIRED' })], [])).toBe(ErrorCode.CouponInvalid);
  });

  it('reveals the state of a matching code, most actionable first', () => {
    const a = (state: CouponCandidate['state'], usedByMe = false): CouponCandidate =>
      course(COURSE_A, { percentOff: 10 }, { state, usedByMe });
    expect(couponProblem([a('EXPIRED')], [COURSE_A])).toBe(ErrorCode.CouponExpired);
    expect(couponProblem([a('SCHEDULED')], [COURSE_A])).toBe(ErrorCode.CouponNotStarted);
    expect(couponProblem([a('EXHAUSTED')], [COURSE_A])).toBe(ErrorCode.CouponExhausted);
    expect(couponProblem([a('ACTIVE', true)], [COURSE_A])).toBe(ErrorCode.CouponAlreadyUsed);
    expect(couponProblem([a('DEACTIVATED')], [COURSE_A])).toBe(ErrorCode.CouponInvalid);
    expect(couponProblem([a('DEACTIVATED', true)], [COURSE_A])).toBe(ErrorCode.CouponInvalid);
    expect(couponProblem([a('EXPIRED'), platform(10, { state: 'SCHEDULED' })], [COURSE_A])).toBe(
      ErrorCode.CouponNotStarted,
    );
    expect(couponProblem([a('EXPIRED'), platform(10, { state: 'EXHAUSTED' })], [COURSE_A])).toBe(
      ErrorCode.CouponExhausted,
    );
  });
});

describe('coupon creation rules that need a clock or the list price', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const days = (n: number): Date => new Date(now.getTime() + n * 86_400_000);
  const percent = { type: 'PERCENT' as const, percentOff: 10 };

  it('course coupons run 1–31 days, start at most 90 days ahead and end in the future', () => {
    const ok = (startsAt: Date, endsAt: Date): string[] =>
      courseCouponIssues({
        window: { startsAt, endsAt },
        now,
        discount: percent,
        listPrice: usd('19.99'),
      }).map((i) => i.path);
    expect(ok(now, days(1))).toEqual([]);
    expect(ok(now, days(31))).toEqual([]);
    expect(ok(days(90), days(100))).toEqual([]);
    expect(ok(now, days(0.5))).toEqual(['endsAt']);
    expect(ok(now, days(31.01))).toEqual(['endsAt']);
    expect(ok(days(91), days(92))).toEqual(['startsAt']);
    expect(ok(days(-10), days(-1))).toEqual(['endsAt']);
    expect(ok(days(5), days(4))).toEqual(['endsAt']);
  });

  it('AMOUNT must be > 0 and at most the current list price', () => {
    const issues = (amountOff: string): string[] =>
      courseCouponIssues({
        window: { startsAt: now, endsAt: days(7) },
        now,
        discount: { type: 'AMOUNT', amountOff: usd(amountOff) },
        listPrice: usd('19.99'),
      }).map((i) => i.path);
    expect(issues('19.99')).toEqual([]);
    expect(issues('0.01')).toEqual([]);
    expect(issues('20.00')).toEqual(['amountOff']);
  });

  it('platform coupons may run up to 90 days', () => {
    const paths = (endsAt: Date): string[] =>
      platformCouponIssues({ window: { startsAt: now, endsAt }, now }).map((i) => i.path);
    expect(paths(days(0.1))).toEqual([]);
    expect(paths(days(90))).toEqual([]);
    expect(paths(days(90.5))).toEqual(['endsAt']);
  });
});
