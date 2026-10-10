import { describe, expect, it } from 'vitest';

import {
  couponFormSchema,
  defaultCouponValues,
  normalizeAmountInput,
  previewPrice,
  toLocalInput,
  type CouponFormValues,
} from './coupon-form';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-10T12:00:00.000Z');
const schema = couponFormSchema('19.99', () => NOW.getTime());

function values(overrides: Partial<CouponFormValues> = {}): CouponFormValues {
  return { ...defaultCouponValues(NOW), code: 'launch-10', percentOff: '10', ...overrides };
}

function fieldErrors(input: CouponFormValues): Record<string, string> {
  const result = schema.safeParse(input);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
}

describe('normalizeAmountInput', () => {
  it.each([
    ['5', '5.00'],
    ['5.5', '5.50'],
    ['05.50', '5.50'],
    [' 19.99 ', '19.99'],
  ])('%j → %s', (input, expected) => expect(normalizeAmountInput(input)).toBe(expected));

  it.each(['', '5.555', '-1', '1e3', 'abc', '5,00'])('rejects %j', (input) =>
    expect(normalizeAmountInput(input)).toBeNull(),
  );
});

describe('couponFormSchema', () => {
  it('outputs the contracts request (code uppercased, empty optionals omitted)', () => {
    const result = schema.parse(values());
    expect(result).toEqual({
      code: 'LAUNCH-10',
      discountType: 'PERCENT',
      percentOff: 10,
      endsAt: new Date(values().endsAt).toISOString(),
    });
  });

  it('sends AMOUNT in canonical money form', () => {
    const result = schema.parse(
      values({ discountType: 'AMOUNT', amountOff: '5', maxRedemptions: '3' }),
    );
    expect(result).toMatchObject({ discountType: 'AMOUNT', amountOff: '5.00', maxRedemptions: 3 });
  });

  it('rejects AMOUNT above the list price and zero', () => {
    expect(fieldErrors(values({ discountType: 'AMOUNT', amountOff: '20.00' }))).toEqual({
      amountOff: 'Must be at most $19.99, the list price.',
    });
    expect(fieldErrors(values({ discountType: 'AMOUNT', amountOff: '0' })).amountOff).toBeTruthy();
    // The list price itself is allowed (a 100 % discount).
    expect(fieldErrors(values({ discountType: 'AMOUNT', amountOff: '19.99' }))).toEqual({});
  });

  it('checks the code pattern and the percent range', () => {
    expect(fieldErrors(values({ code: 'ab' })).code).toMatch(/4–20/);
    expect(fieldErrors(values({ code: 'with space' })).code).toMatch(/4–20/);
    expect(fieldErrors(values({ percentOff: '0' })).percentOff).toBeTruthy();
    expect(fieldErrors(values({ percentOff: '101' })).percentOff).toBeTruthy();
    expect(fieldErrors(values({ percentOff: '12.5' })).percentOff).toBeTruthy();
  });

  it('checks the 1–31 day window relative to now', () => {
    const at = (ms: number) => toLocalInput(new Date(NOW.getTime() + ms));
    expect(fieldErrors(values({ endsAt: at(-DAY_MS) })).endsAt).toBe('Must be in the future.');
    expect(fieldErrors(values({ endsAt: at(12 * 60 * 60 * 1000) })).endsAt).toMatch(/1–31 days/);
    expect(fieldErrors(values({ endsAt: at(40 * DAY_MS) })).endsAt).toMatch(/1–31 days/);
    expect(fieldErrors(values({ startsAt: at(5 * DAY_MS), endsAt: at(3 * DAY_MS) })).endsAt).toBe(
      'Must be after the start.',
    );
    expect(
      fieldErrors(values({ startsAt: at(100 * DAY_MS), endsAt: at(110 * DAY_MS) })).startsAt,
    ).toMatch(/90 days/);
  });
});

describe('previewPrice', () => {
  it('rounds PERCENT half up and caps AMOUNT at the list price', () => {
    expect(
      previewPrice('19.99', { discountType: 'PERCENT', percentOff: '10', amountOff: '' }),
    ).toBe('17.99');
    expect(previewPrice('19.99', { discountType: 'AMOUNT', percentOff: '', amountOff: '5' })).toBe(
      '14.99',
    );
    expect(
      previewPrice('19.99', { discountType: 'PERCENT', percentOff: 'x', amountOff: '' }),
    ).toBeNull();
  });
});
