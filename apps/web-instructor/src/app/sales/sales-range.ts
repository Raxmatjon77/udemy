import { z } from 'zod';
import { SalesSummaryQuerySchema, type SalesSummaryQuery } from '@udemy/contracts';

/**
 * The `/sales` date range: two `<input type="date">` values (local calendar days, both
 * inclusive) → the api's half-open `[from, to)` ISO range, validated with the contracts
 * `SalesSummaryQuerySchema` (from < to, at most 366 days).
 */

export interface SalesRangeValues {
  /** `yyyy-mm-dd`. */
  from: string;
  /** `yyyy-mm-dd`, inclusive. */
  to: string;
}

const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of a `yyyy-mm-dd` day, or null. */
function localMidnight(day: string): Date | null {
  if (!DATE_INPUT.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) || date.getDate() !== d ? null : date;
}

export function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The last `days` calendar days up to and including `today`. */
export function lastDays(days: number, today: Date): SalesRangeValues {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { from: toDateInput(start), to: toDateInput(today) };
}

export function toSalesQuery(values: SalesRangeValues): SalesSummaryQuery {
  const from = localMidnight(values.from) ?? new Date(NaN);
  const to = localMidnight(values.to) ?? new Date(NaN);
  const toExclusive = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return { from: from.toISOString(), to: toExclusive.toISOString() };
}

export const SalesRangeFormSchema = z
  .object({ from: z.string(), to: z.string() })
  .superRefine((values, ctx) => {
    const from = localMidnight(values.from);
    const to = localMidnight(values.to);
    if (from === null) ctx.addIssue({ code: 'custom', path: ['from'], message: 'Enter a date.' });
    if (to === null) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Enter a date.' });
    if (from !== null && to !== null && to.getTime() < from.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Must be on or after the start.' });
    }
  })
  .transform(toSalesQuery)
  .pipe(SalesSummaryQuerySchema);

/** `[from, to)` back to the inclusive days, for headings. */
export function rangeDays(query: SalesSummaryQuery): SalesRangeValues {
  return {
    from: toDateInput(new Date(query.from)),
    to: toDateInput(new Date(Date.parse(query.to) - DAY_MS / 2)),
  };
}
