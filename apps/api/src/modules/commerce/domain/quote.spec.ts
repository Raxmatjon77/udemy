import { createHash } from 'node:crypto';
import { ErrorCode, PRICE_TIERS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { PriceNotAllowed } from './commerce.errors';
import { type CouponCandidate, CouponTerms } from './coupon-terms';
import { Money } from './money';
import { PriceTier } from './price-tier';
import { purchaseBlockReason } from './purchase-eligibility';
import {
  assembleQuote,
  type QuoteCourse,
  type QuoteInput,
  type QuoteRow,
  quoteFingerprint,
} from './quote';
import { prng } from './testing/prng';

const USER = '0190c000-0000-7000-8000-000000000001';
const OWNER = '0190c000-0000-7000-8000-000000000002';
const ids = Array.from({ length: 8 }, (_, i) => `0190d000-0000-7000-8000-00000000000${i}`);
const usd = (amount: string): Money => Money.fromDecimal(amount, 'USD');
const at = (n: number): Date => new Date(Date.UTC(2026, 9, 10, 12, 0, n));

function courseOf(id: string, overrides: Partial<QuoteCourse> = {}): QuoteCourse {
  return {
    id,
    ownerId: OWNER,
    status: 'PUBLISHED',
    slug: `slug-${id.slice(-2)}`,
    title: `Course ${id.slice(-2)}`,
    hasThumbnail: true,
    ...overrides,
  };
}

function row(
  courseId: string,
  list: string | null,
  n: number,
  extra: Partial<QuoteRow> = {},
): QuoteRow {
  return {
    courseId,
    addedAt: at(n),
    listAmount: list,
    currency: list === null ? null : 'USD',
    couponId: null,
    discountAmount: '0.00',
    ...extra,
  };
}

function input(overrides: Partial<QuoteInput>): QuoteInput {
  return {
    currency: 'USD',
    userId: USER,
    couponCode: null,
    rows: [],
    candidates: [],
    courses: new Map(),
    enrolledCourseIds: new Set(),
    ...overrides,
  };
}

describe('PriceTier (D2)', () => {
  it('accepts exactly the tiers, FREE included', () => {
    for (const amount of PRICE_TIERS.USD)
      expect(PriceTier.of(amount, 'USD').price.toDecimal()).toBe(amount);
    expect(PriceTier.of('0.00', 'USD').isFree).toBe(true);
    expect(PriceTier.of('19.99', 'USD').isFree).toBe(false);
    for (const bad of ['13.37', '19.98', '25.00', '200.00', '19.9', '-19.99']) {
      expect(() => PriceTier.of(bad, 'USD'), bad).toThrow(PriceNotAllowed);
    }
  });
});

describe('purchaseBlockReason (design §4, checks in order)', () => {
  const published = { id: ids[0]!, ownerId: OWNER, status: 'PUBLISHED' as const };
  const base = {
    course: published,
    price: usd('19.99'),
    currency: 'USD',
    userId: USER,
    enrolled: false,
  };

  it('reports the FIRST failing check', () => {
    expect(purchaseBlockReason(base)).toBeNull();
    expect(purchaseBlockReason({ ...base, course: null })).toBe(ErrorCode.CourseNotFound);
    // Archived beats everything after it, even "no price" and "owner".
    expect(
      purchaseBlockReason({
        ...base,
        course: { ...published, status: 'ARCHIVED', ownerId: USER },
        price: null,
      }),
    ).toBe(ErrorCode.CourseNotForSale);
    expect(purchaseBlockReason({ ...base, price: null, enrolled: true })).toBe(
      ErrorCode.CourseNotForSale,
    );
    expect(
      purchaseBlockReason({ ...base, price: usd('0.00'), course: { ...published, ownerId: USER } }),
    ).toBe(ErrorCode.CourseIsFree);
    expect(
      purchaseBlockReason({ ...base, course: { ...published, ownerId: USER }, enrolled: true }),
    ).toBe(ErrorCode.CannotPurchaseOwnCourse);
    expect(purchaseBlockReason({ ...base, enrolled: true })).toBe(ErrorCode.AlreadyEnrolled);
  });
});

describe('assembleQuote', () => {
  it('splits purchasable and unavailable lines with their reasons, in cart order', () => {
    const [a, b, c, d, e, f] = ids as [string, string, string, string, string, string];
    const quote = assembleQuote(
      input({
        rows: [
          row(a, '19.99', 1),
          row(b, null, 2),
          row(c, '0.00', 3),
          row(d, '24.99', 4),
          row(e, '29.99', 5),
          row(f, '34.99', 6),
        ],
        courses: new Map([
          [a, courseOf(a)],
          [b, courseOf(b)],
          [c, courseOf(c)],
          [d, courseOf(d, { ownerId: USER })],
          [e, courseOf(e)],
          // f is unknown to the catalog (deleted)
        ]),
        enrolledCourseIds: new Set([e]),
      }),
    );
    expect(quote.lines.map((l) => l.course.id)).toEqual([a]);
    expect(quote.unavailable.map((u) => [u.courseId, u.reason, u.title])).toEqual([
      [b, ErrorCode.CourseNotForSale, 'Course 01'],
      [c, ErrorCode.CourseIsFree, 'Course 02'],
      [d, ErrorCode.CannotPurchaseOwnCourse, 'Course 03'],
      [e, ErrorCode.AlreadyEnrolled, 'Course 04'],
      [f, ErrorCode.CourseNotFound, null],
    ]);
    expect(quote.itemCount).toBe(6);
    expect(quote.totals.total.toDecimal()).toBe('19.99');
    expect(quote.coupon).toBeNull();
  });

  it('keeps the SQL discount, totals add up, and an applied coupon has no problem', () => {
    const [a, b] = ids as [string, string];
    const p: CouponCandidate = {
      terms: CouponTerms.of({
        id: ids[7]!,
        scope: 'PLATFORM',
        courseId: null,
        discount: { type: 'PERCENT', percentOff: 50 },
      }),
      state: 'ACTIVE',
      usedByMe: false,
    };
    const quote = assembleQuote(
      input({
        couponCode: 'HALF',
        rows: [
          row(a, '19.99', 1, { couponId: p.terms.id, discountAmount: '10.00' }),
          row(b, '24.99', 2, { couponId: p.terms.id, discountAmount: '12.50' }),
        ],
        candidates: [p],
        courses: new Map([
          [a, courseOf(a)],
          [b, courseOf(b)],
        ]),
      }),
    );
    expect(
      quote.lines.map((l) => [l.list.toDecimal(), l.discount.toDecimal(), l.final.toDecimal()]),
    ).toEqual([
      ['19.99', '10.00', '9.99'],
      ['24.99', '12.50', '12.49'],
    ]);
    expect(quote.totals.list.toDecimal()).toBe('44.98');
    expect(quote.totals.discount.toDecimal()).toBe('22.50');
    expect(quote.totals.total.toDecimal()).toBe('22.48');
    expect(quote.coupon).toEqual({ code: 'HALF', applied: true, problem: null });
    expect(quote.divergences).toEqual([]);
  });

  it('drops the coupon of a line that became unavailable and reports why the code does not apply', () => {
    const [a] = ids as [string];
    const c: CouponCandidate = {
      terms: CouponTerms.of({
        id: ids[6]!,
        scope: 'COURSE',
        courseId: a,
        discount: { type: 'PERCENT', percentOff: 10 },
      }),
      state: 'ACTIVE',
      usedByMe: false,
    };
    const quote = assembleQuote(
      input({
        couponCode: 'TEN',
        rows: [row(a, '19.99', 1, { couponId: c.terms.id, discountAmount: '2.00' })],
        candidates: [c],
        courses: new Map([[a, courseOf(a)]]),
        enrolledCourseIds: new Set([a]),
      }),
    );
    expect(quote.lines).toEqual([]);
    expect(quote.totals.discount.isZero()).toBe(true);
    expect(quote.coupon).toEqual({ code: 'TEN', applied: false, problem: ErrorCode.CouponInvalid });
  });

  it('reports a divergence between the SQL pick and the domain best-of (SQL wins)', () => {
    const [a] = ids as [string];
    const c: CouponCandidate = {
      terms: CouponTerms.of({
        id: ids[6]!,
        scope: 'COURSE',
        courseId: a,
        discount: { type: 'PERCENT', percentOff: 10 },
      }),
      state: 'EXHAUSTED', // became exhausted between the two quote statements
      usedByMe: false,
    };
    const quote = assembleQuote(
      input({
        couponCode: 'TEN',
        rows: [row(a, '19.99', 1, { couponId: c.terms.id, discountAmount: '2.00' })],
        candidates: [c],
        courses: new Map([[a, courseOf(a)]]),
      }),
    );
    expect(quote.totals.total.toDecimal()).toBe('17.99');
    expect(quote.divergences).toEqual([
      {
        courseId: a,
        sql: { couponId: c.terms.id, discount: '2.00' },
        domain: { couponId: null, discount: '0.00' },
      },
    ]);
  });

  it('refuses rows that break 0 <= discount <= list', () => {
    const [a] = ids as [string];
    const courses = new Map([[a, courseOf(a)]]);
    expect(() =>
      assembleQuote(
        input({
          rows: [row(a, '19.99', 1, { couponId: ids[6]!, discountAmount: '20.00' })],
          courses,
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      assembleQuote(input({ rows: [row(a, '19.99', 1, { discountAmount: '1.00' })], courses })),
    ).toThrow(RangeError);
  });

  it('property: list = discount + total, and total = Σ final, for random carts', () => {
    const r = prng(77);
    for (let i = 0; i < 500; i++) {
      const rows = ids.slice(0, r.int(0, 8)).map((id, n) => {
        const list = Money.ofMinor(r.int(1, 999_999), 'USD');
        const discount = Money.ofMinor(r.int(0, list.minor), 'USD');
        return row(id, list.toDecimal(), n, {
          couponId: discount.isZero() ? null : ids[7]!,
          discountAmount: discount.toDecimal(),
        });
      });
      const quote = assembleQuote(
        input({ rows, courses: new Map(rows.map((x) => [x.courseId, courseOf(x.courseId)])) }),
      );
      expect(quote.totals.discount.add(quote.totals.total).equals(quote.totals.list)).toBe(true);
      expect(
        Money.sum(
          quote.lines.map((l) => l.final),
          'USD',
        ).equals(quote.totals.total),
      ).toBe(true);
    }
  });
});

describe('quoteFingerprint', () => {
  const line = (id: string, final: string, couponId: string | null = null) => ({
    course: { id },
    final: usd(final),
    couponId,
  });

  it('is order-independent and changes with any price, coupon or currency input', () => {
    const [a, b] = ids as [string, string];
    const fp = quoteFingerprint('USD', [line(a, '9.99', ids[7]!), line(b, '24.99')]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(quoteFingerprint('USD', [line(b, '24.99'), line(a, '9.99', ids[7]!)])).toBe(fp);
    expect(quoteFingerprint('USD', [line(a, '9.98', ids[7]!), line(b, '24.99')])).not.toBe(fp);
    expect(quoteFingerprint('USD', [line(a, '9.99', ids[6]!), line(b, '24.99')])).not.toBe(fp);
    expect(quoteFingerprint('USD', [line(a, '9.99', ids[7]!)])).not.toBe(fp);
  });

  it('hashes "currency|sorted courseId:final pairs|sorted coupon ids" (T15 stores the raw digest)', () => {
    const [a, b] = ids as [string, string];
    const expected = createHash('sha256')
      .update(`USD|${a}:9.99,${b}:24.99|${ids[7]}`)
      .digest('hex');
    expect(quoteFingerprint('USD', [line(b, '24.99'), line(a, '9.99', ids[7]!)])).toBe(expected);
  });
});
