import {
  DEFAULT_CURRENCY,
  formatMoney,
  isFreeAmount,
  minorToMoney,
  moneyToMinor,
  percentOfMinor,
  type Currency,
} from '@udemy/contracts';

/**
 * Money display for the instructor app. Amounts are decimal strings (design D3) and every
 * computation goes through the contracts' integer minor-unit helpers, never floats.
 */

/** Display locale: fixed so server and client render the same string. */
const LOCALE = 'en-US';

export function money(amount: string, currency: Currency = DEFAULT_CURRENCY): string {
  return formatMoney(amount, currency, LOCALE);
}

/** "Free" for 0.00, else the formatted amount. */
export function priceLabel(amount: string, currency: Currency = DEFAULT_CURRENCY): string {
  return isFreeAmount(amount) ? 'Free' : money(amount, currency);
}

/**
 * The instructor's revenue share (design §13 Q2: a flat 70 % of the net paid amount; the
 * api's `COMMERCE_INSTRUCTOR_SHARE_BPS=7000`). The contracts do not export the share yet, so
 * the UI only ever shows it as an **estimate**; actual shares come from the sales endpoints.
 */
export const INSTRUCTOR_SHARE_PERCENT = 70;

/** `round_half_up(amount × 70 %)`, like the `order_lines` generated column. */
export function estimateInstructorShare(amount: string): string {
  return minorToMoney(percentOfMinor(moneyToMinor(amount), INSTRUCTOR_SHARE_PERCENT));
}
