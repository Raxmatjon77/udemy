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
 * `?cursor=&limit=` query parameters with a custom page size bound (e.g. the public course
 * browse caps `limit` at 48). Query values arrive as strings, so `limit` is coerced, and an
 * empty value (`?cursor=`) means "absent".
 */
export function paginationQuerySchema(maxLimit: number, defaultLimit: number) {
  return z.object({
    cursor: z.preprocess(emptyToUndefined, CursorSchema.optional()),
    limit: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
    ),
  });
}

/** `?cursor=&limit=` with the default bounds (limit 1–100, default 20). */
export const PaginationQuerySchema = paginationQuerySchema(PAGE_LIMIT_MAX, PAGE_LIMIT_DEFAULT);
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

/**
 * Query-string boolean (`?unreadOnly=true`): only `true` and `false` are accepted, an empty or
 * missing value is the default. A preprocess, not a transform, so Swagger still renders it.
 */
export function booleanQueryParam(defaultValue: boolean) {
  return z.preprocess((value: unknown) => {
    if (value === '' || value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean().default(defaultValue));
}

/**
 * Page bounds of the Phase 5 lists (notes, attempts, certificates, reviews, Q&A, announcements,
 * notifications, wishlist, moderation): `limit` 1–50, default 20.
 */
export const COMPACT_PAGE_LIMIT_MAX = 50;
export const COMPACT_PAGE_LIMIT_DEFAULT = 20;

/** `?cursor=&limit=` with the compact bounds (limit 1–50, default 20). */
export const CompactPaginationQuerySchema = paginationQuerySchema(
  COMPACT_PAGE_LIMIT_MAX,
  COMPACT_PAGE_LIMIT_DEFAULT,
);
export type CompactPaginationQuery = z.output<typeof CompactPaginationQuerySchema>;
