import { ErrorCode } from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';
import type { MyCoursesKeyset } from './ports/course.repository';

/**
 * `updated_at` exactly as SQL printed it (UTC, microseconds). A JS Date would drop the
 * microseconds and `(updated_at, id) < cursor` would skip rows (design §14).
 */
const KeysetSchema = z.object({
  u: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

/** Opaque cursor of "My courses": base64url of `{ u: updatedAt, i: id }`. */
export function encodeMyCoursesCursor(keyset: MyCoursesKeyset): string {
  return Buffer.from(JSON.stringify({ u: keyset.updatedAt, i: keyset.id }), 'utf8').toString(
    'base64url',
  );
}

/** @throws ValidationError (422 `validation_failed`) for anything this api did not produce */
export function decodeMyCoursesCursor(cursor: string): MyCoursesKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  return { updatedAt: result.data.u, id: result.data.i };
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
