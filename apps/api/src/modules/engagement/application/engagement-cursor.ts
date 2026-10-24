import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';

/**
 * Opaque keyset cursor of every engagement list (reviews, wishlist; Q&A and announcements in
 * P5-T13): base64url of `{ t, i }`, where `t` is the sort timestamp EXACTLY as SQL printed it
 * (UTC, microseconds; a JS Date would drop the microseconds and `(t, id) < cursor` would skip
 * rows, P2 design §14) and `i` the tie-breaking uuid.
 */
export interface TimestampKeyset {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` */
  readonly at: string;
  readonly id: string;
}

const KeysetSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

export function encodeKeyset(keyset: TimestampKeyset): string {
  return Buffer.from(JSON.stringify({ t: keyset.at, i: keyset.id }), 'utf8').toString('base64url');
}

/** @throws ValidationError (422 `validation_failed`) for anything this api did not produce */
export function decodeKeyset(cursor: string): TimestampKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  return { at: result.data.t, id: result.data.i };
}

export function decodeOptionalKeyset(cursor: string | undefined): TimestampKeyset | null {
  return cursor === undefined ? null : decodeKeyset(cursor);
}

/**
 * Splits a `limit + 1` fetch into the page and the next cursor (null on the last page).
 */
export function toPage<TRow, TItem>(
  rows: readonly TRow[],
  limit: number,
  keysetOf: (row: TRow) => TimestampKeyset,
  map: (rows: readonly TRow[]) => TItem[],
): { items: TItem[]; nextCursor: string | null } {
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeKeyset(keysetOf(last)) : null;
  return { items: map(pageRows), nextCursor };
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
