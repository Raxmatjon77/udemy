import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';
import type { OrderKeyset } from './ports/order.repository';

/**
 * `placed_at` exactly as SQL printed it (UTC, microseconds): a JS Date would drop the
 * microseconds and `(placed_at, id) < cursor` would skip or repeat rows (P2 design §14).
 */
const KeysetSchema = z.object({
  p: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

/** Opaque cursor of "My orders": base64url of `{ p: placedAt, i: orderId }`. */
export function encodeOrderCursor(keyset: OrderKeyset): string {
  return Buffer.from(JSON.stringify({ p: keyset.placedAt, i: keyset.id }), 'utf8').toString(
    'base64url',
  );
}

/** @throws ValidationError (422 `validation_failed`) for anything this api did not produce */
export function decodeOrderCursor(cursor: string): OrderKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  return { placedAt: result.data.p, id: result.data.i };
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
