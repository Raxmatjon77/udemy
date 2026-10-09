import { z } from 'zod';

/**
 * Keyset pagination. The cursor is opaque to clients: the api encodes it as base64url of
 * the last row's sort key (e.g. `{ createdAt, id }`) and decodes/validates it itself.
 */
export const CursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor');
export type Cursor = z.infer<typeof CursorSchema>;

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;

/**
 * `?cursor=&limit=` query parameters. Query values arrive as strings, so `limit` is
 * coerced, and an empty value (`?cursor=`) means "absent".
 */
export const PaginationQuerySchema = z.object({
  cursor: z.preprocess(emptyToUndefined, CursorSchema.optional()),
  limit: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  ),
});
export type PaginationQuery = z.output<typeof PaginationQuerySchema>;

/** A page of items: `{ items, nextCursor }`; `nextCursor` is null on the last page. */
export function pageSchema<TItem extends z.ZodType>(item: TItem) {
  return z.object({
    items: z.array(item),
    nextCursor: CursorSchema.nullable(),
  });
}

export interface Page<TItem> {
  items: TItem[];
  nextCursor: Cursor | null;
}

/**
 * Query-string helper: `?status=` is sent by many forms/links for "no filter".
 * Used with `z.preprocess`, which still renders the inner schema in Swagger (input mode).
 */
export function emptyToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}
