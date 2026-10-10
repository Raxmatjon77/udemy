import { z } from 'zod';
import {
  COUPON_CODE_PATTERN,
  COUPON_DISCOUNT_TYPES,
  COUPON_LIMITS,
  compareMoney,
  CreateCourseCouponRequestSchema,
  isMoneyAmount,
  moneyToMinor,
  priceAfterDiscount,
  type CreateCourseCouponRequest,
  type DiscountTerms,
} from '@udemy/contracts';

import { money } from '@/lib/money';

/**
 * The "Create coupon" form (Phase 4 design D5). Inputs are strings (`<input>` values); the
 * schema checks what the user can fix right here (number formats, AMOUNT ≤ list price, the
 * validity window relative to now), converts to the request and then pipes it through the
 * contracts `CreateCourseCouponRequestSchema`, the shape the api validates.
 */

export const COUPON_FORM_FIELDS = [
  'code',
  'discountType',
  'percentOff',
  'amountOff',
  'startsAt',
  'endsAt',
  'maxRedemptions',
] as const;
export type CouponFormField = (typeof COUPON_FORM_FIELDS)[number];

export interface CouponFormValues {
  code: string;
  discountType: (typeof COUPON_DISCOUNT_TYPES)[number];
  percentOff: string;
  amountOff: string;
  /** `<input type="datetime-local">` value (local time); empty means "now". */
  startsAt: string;
  endsAt: string;
  /** Empty means unlimited. */
  maxRedemptions: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WHOLE_NUMBER = /^\d+$/;
const DECIMAL_INPUT = /^\d+(?:\.\d{1,2})?$/;

/** `"5"` / `"5.5"` / `"05.50"` → `"5.50"` (the canonical money string), or null. */
export function normalizeAmountInput(input: string): string | null {
  const value = input.trim();
  if (!DECIMAL_INPUT.test(value)) return null;
  const [units = '0', cents = ''] = value.split('.');
  const amount = `${String(Number(units))}.${cents.padEnd(2, '0')}`;
  return isMoneyAmount(amount) ? amount : null;
}

/** A local `datetime-local` value (`2026-10-11T09:30`) → epoch ms, or null. */
function parseLocal(value: string): number | null {
  if (value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** A `Date` → the `datetime-local` value in local time (minutes precision). */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function defaultCouponValues(now: Date): CouponFormValues {
  return {
    code: '',
    discountType: 'PERCENT',
    percentOff: '',
    amountOff: '',
    startsAt: '',
    endsAt: toLocalInput(new Date(now.getTime() + 7 * DAY_MS)),
    maxRedemptions: '',
  };
}

function toRequest(values: CouponFormValues): CreateCourseCouponRequest {
  const startsAt = parseLocal(values.startsAt);
  const endsAt = parseLocal(values.endsAt) ?? 0;
  const common = {
    code: values.code.trim().toUpperCase(),
    endsAt: new Date(endsAt).toISOString(),
    ...(startsAt === null ? {} : { startsAt: new Date(startsAt).toISOString() }),
    ...(values.maxRedemptions.trim() === ''
      ? {}
      : { maxRedemptions: Number(values.maxRedemptions.trim()) }),
  };
  return values.discountType === 'PERCENT'
    ? { ...common, discountType: 'PERCENT', percentOff: Number(values.percentOff.trim()) }
    : {
        ...common,
        discountType: 'AMOUNT',
        amountOff: normalizeAmountInput(values.amountOff) ?? values.amountOff,
      };
}

/**
 * The form schema for a course whose list price is `listAmount` (a paid tier). `now` is read
 * on every validation, so the window check is relative to the moment of submitting.
 */
export function couponFormSchema(listAmount: string, now: () => number = Date.now) {
  const { minPercentOff, maxPercentOff, maxRedemptions, maxStartAheadDays } = COUPON_LIMITS;
  const { courseWindowMinDays: minDays, courseWindowMaxDays: maxDays } = COUPON_LIMITS;
  return z
    .object({
      code: z.string(),
      discountType: z.enum(COUPON_DISCOUNT_TYPES),
      percentOff: z.string(),
      amountOff: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      maxRedemptions: z.string(),
    })
    .superRefine((values, ctx) => {
      const issue = (path: CouponFormField, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });

      const code = values.code.trim().toUpperCase();
      if (code === '') issue('code', 'Enter a code.');
      else if (!COUPON_CODE_PATTERN.test(code)) {
        issue('code', 'Use 4–20 letters, digits, "_" or "-".');
      }

      if (values.discountType === 'PERCENT') {
        const percent = values.percentOff.trim();
        const n = Number(percent);
        if (!WHOLE_NUMBER.test(percent) || n < minPercentOff || n > maxPercentOff) {
          issue('percentOff', `Enter a whole number from ${minPercentOff} to ${maxPercentOff}.`);
        }
      } else {
        const amount = normalizeAmountInput(values.amountOff);
        if (amount === null || moneyToMinor(amount) === 0) {
          issue('amountOff', 'Enter an amount greater than 0, e.g. 5.00.');
        } else if (compareMoney(amount, listAmount) > 0) {
          issue('amountOff', `Must be at most ${money(listAmount)}, the list price.`);
        }
      }

      const max = values.maxRedemptions.trim();
      if (
        max !== '' &&
        (!WHOLE_NUMBER.test(max) || Number(max) < 1 || Number(max) > maxRedemptions)
      ) {
        issue(
          'maxRedemptions',
          `Enter a whole number from 1 to ${maxRedemptions.toLocaleString('en-US')}, or leave it empty.`,
        );
      }

      const at = now();
      const startsAt = values.startsAt === '' ? at : parseLocal(values.startsAt);
      const endsAt = parseLocal(values.endsAt);
      if (startsAt === null) issue('startsAt', 'Enter a date and time, or leave it empty.');
      else if (startsAt - at > maxStartAheadDays * DAY_MS) {
        issue('startsAt', `The coupon can start at most ${maxStartAheadDays} days from now.`);
      }
      if (endsAt === null) issue('endsAt', 'Enter a date and time.');
      else if (endsAt <= at) issue('endsAt', 'Must be in the future.');
      else if (startsAt !== null) {
        const days = (endsAt - startsAt) / DAY_MS;
        if (days <= 0) issue('endsAt', 'Must be after the start.');
        else if (days < minDays || days > maxDays) {
          issue('endsAt', `The coupon must run for ${minDays}–${maxDays} days.`);
        }
      }
    })
    .transform(toRequest)
    .pipe(CreateCourseCouponRequestSchema);
}

/** "Students pay $9.99" for valid terms, else null (the live preview). */
export function previewPrice(
  listAmount: string,
  values: Pick<CouponFormValues, 'discountType' | 'percentOff' | 'amountOff'>,
): string | null {
  let terms: DiscountTerms;
  if (values.discountType === 'PERCENT') {
    const percent = values.percentOff.trim();
    if (!WHOLE_NUMBER.test(percent)) return null;
    const n = Number(percent);
    if (n < COUPON_LIMITS.minPercentOff || n > COUPON_LIMITS.maxPercentOff) return null;
    terms = { discountType: 'PERCENT', percentOff: n };
  } else {
    const amount = normalizeAmountInput(values.amountOff);
    if (amount === null || moneyToMinor(amount) === 0) return null;
    terms = { discountType: 'AMOUNT', amountOff: amount };
  }
  return priceAfterDiscount(listAmount, terms);
}
