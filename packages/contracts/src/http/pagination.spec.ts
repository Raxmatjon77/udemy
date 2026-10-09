import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pageSchema, PaginationQuerySchema } from './pagination';

describe('PaginationQuerySchema', () => {
  it('defaults limit to 20 and coerces strings', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(PaginationQuerySchema.parse({ limit: '1', cursor: 'abc' })).toEqual({
      limit: 1,
      cursor: 'abc',
    });
    expect(PaginationQuerySchema.parse({ limit: '100' })).toEqual({ limit: 100 });
  });

  it('rejects limits outside 1–100 and malformed cursors', () => {
    for (const limit of ['0', '101', '1.5', 'abc', '-1']) {
      expect(PaginationQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(PaginationQuerySchema.safeParse({ cursor: 'a+b=' }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ cursor: 'a'.repeat(513) }).success).toBe(false);
  });
});

describe('pageSchema', () => {
  const Page = pageSchema(z.object({ n: z.number() }));

  it('accepts a page and a last page', () => {
    expect(Page.safeParse({ items: [{ n: 1 }], nextCursor: 'next' }).success).toBe(true);
    expect(Page.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });

  it('requires nextCursor to be present', () => {
    expect(Page.safeParse({ items: [] }).success).toBe(false);
  });
});
