import { describe, expect, it } from 'vitest';

import { lastDays, rangeDays, SalesRangeFormSchema, toSalesQuery } from './sales-range';

describe('sales range', () => {
  it('turns inclusive local days into the half-open [from, to) query', () => {
    const query = toSalesQuery({ from: '2026-09-01', to: '2026-09-30' });
    expect(query.from).toBe(new Date(2026, 8, 1).toISOString());
    expect(query.to).toBe(new Date(2026, 9, 1).toISOString());
    expect(rangeDays(query)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('lastDays includes today', () => {
    expect(lastDays(30, new Date(2026, 9, 10, 15))).toEqual({
      from: '2026-09-11',
      to: '2026-10-10',
    });
  });

  it('validates the order and the 366-day limit from the contract', () => {
    const issues = (from: string, to: string) => {
      const result = SalesRangeFormSchema.safeParse({ from, to });
      return result.success ? [] : result.error.issues.map((i) => i.message);
    };
    expect(issues('2026-09-01', '2026-09-01')).toEqual([]);
    expect(issues('2026-09-02', '2026-09-01')).toEqual(['Must be on or after the start.']);
    expect(issues('2024-01-01', '2026-01-01')).toEqual(['The range must be at most 366 days']);
    expect(issues('', '2026-01-01')).toEqual(['Enter a date.']);
  });
});
