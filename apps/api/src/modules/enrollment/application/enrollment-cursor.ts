import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';
import type { MyLearningKeyset } from './ports/enrollment.repository';

/**
 * `granted_at` exactly as SQL printed it (UTC, microseconds): a JS Date would drop the
 * microseconds and `(granted_at, id) < cursor` would skip rows (P2 design §14).
 */
const KeysetSchema = z.object({
  g: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

/** Opaque cursor of "My learning": base64url of `{ g: grantedAt, i: enrollmentId }`. */
export function encodeMyLearningCursor(keyset: MyLearningKeyset): string {
  return Buffer.from(JSON.stringify({ g: keyset.grantedAt, i: keyset.id }), 'utf8').toString(
    'base64url',
  );
}

/** @throws ValidationError (422 `validation_failed`) for anything this api did not produce */
export function decodeMyLearningCursor(cursor: string): MyLearningKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  return { grantedAt: result.data.g, id: result.data.i };
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
