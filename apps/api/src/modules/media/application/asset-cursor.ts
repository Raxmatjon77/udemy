import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';
import type { AssetKeyset } from './ports/media-asset.repository';

/**
 * `created_at` exactly as SQL printed it (UTC, microseconds). A JS Date would drop the
 * microseconds and `(created_at, id) < cursor` would skip rows (design §14).
 */
const KeysetSchema = z.object({
  c: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

/** Opaque cursor of the asset listing: base64url of `{ c: createdAt, i: id }`. */
export function encodeAssetCursor(keyset: AssetKeyset): string {
  return Buffer.from(JSON.stringify({ c: keyset.createdAt, i: keyset.id }), 'utf8').toString(
    'base64url',
  );
}

/** @throws ValidationError (422 `validation_failed`) for anything this api did not produce */
export function decodeAssetCursor(cursor: string): AssetKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  return { createdAt: result.data.c, id: result.data.i };
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
