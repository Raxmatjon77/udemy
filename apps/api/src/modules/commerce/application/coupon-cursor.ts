import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';

const CouponKeysetSchema = z.object({ c: z.uuid() });

/**
 * Opaque cursor of coupon lists: base64url of `{ c: couponId }`. Coupon ids are uuidv7 (time
 * ordered), so `id DESC` is "newest first" and the keyset needs no timestamp (exact, no
 * microsecond loss, design §14).
 */
export function encodeCouponCursor(couponId: string): string {
  return Buffer.from(JSON.stringify({ c: couponId }), 'utf8').toString('base64url');
}

/** @throws ValidationError (422 `validation_failed`) for anything this api did not produce */
export function decodeCouponCursor(cursor: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = CouponKeysetSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  return result.data.c;
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
