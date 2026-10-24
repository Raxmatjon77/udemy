import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';

/**
 * Opaque keyset cursor of the learning lists (notes, quiz attempts, certificates): base64url of
 * `{ t: timestamp, i: id }`, where `t` is the sort timestamp exactly as SQL printed it (UTC,
 * microseconds), never a JS Date (P2 §14: a Date drops the microseconds and skips rows).
 */
export interface TimestampKeyset {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  readonly at: string;
  readonly id: string;
}

const KeysetSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

export function encodeLearningCursor(keyset: TimestampKeyset): string {
  return Buffer.from(JSON.stringify({ t: keyset.at, i: keyset.id }), 'utf8').toString('base64url');
}

/** @throws ValidationError (422 `validation_failed`) for anything this api did not produce */
export function decodeLearningCursor(cursor: string): TimestampKeyset {
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

/** `{ items, nextCursor }` from `limit + 1` rows. */
export function pageOf<TRow, TItem>(
  rows: readonly TRow[],
  limit: number,
  keysetOf: (row: TRow) => TimestampKeyset,
  toItem: (row: TRow) => TItem,
): { items: TItem[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toItem),
    nextCursor:
      rows.length > limit && last !== undefined ? encodeLearningCursor(keysetOf(last)) : null,
  };
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
