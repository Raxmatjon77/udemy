import { ErrorCode, type QaSort } from '@udemy/contracts';
import type { QuestionCursor } from '@udemy/db';
import { ValidationError } from '@udemy/nest-common/errors';
import { z } from 'zod';

/**
 * Opaque cursor of `GET /courses/:courseId/questions`: base64url of the last row's sort key
 * for the requested sort (`recent`: last activity, `top`: upvotes, `unanswered`: creation),
 * then its id. Timestamps are carried EXACTLY as SQL printed them (`::text`, microseconds and
 * offset), never as a JS Date (P2 design §14). A cursor of another sort is invalid (the client
 * restarts from the first page when it changes the sort).
 */
const SQL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2}){0,2})$/;

const CursorSchema = z.discriminatedUnion('s', [
  z.object({ s: z.literal('recent'), t: z.string().regex(SQL_TIMESTAMP), i: z.uuid() }),
  z.object({ s: z.literal('top'), v: z.number().int().min(0).max(2_147_483_647), i: z.uuid() }),
  z.object({ s: z.literal('unanswered'), t: z.string().regex(SQL_TIMESTAMP), i: z.uuid() }),
]);

export function encodeQuestionCursor(cursor: QuestionCursor): string {
  const raw =
    cursor.sort === 'recent'
      ? { s: cursor.sort, t: cursor.lastActivityAt, i: cursor.id }
      : cursor.sort === 'top'
        ? { s: cursor.sort, v: cursor.upvoteCount, i: cursor.id }
        : { s: cursor.sort, t: cursor.createdAt, i: cursor.id };
  return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');
}

/** @throws ValidationError (422 `validation_failed`) for a foreign or other-sort cursor */
export function decodeQuestionCursor(
  cursor: string | undefined,
  sort: QaSort,
): QuestionCursor | null {
  if (cursor === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success || result.data.s !== sort) throw invalidCursor();
  const c = result.data;
  switch (c.s) {
    case 'recent':
      return { sort: 'recent', lastActivityAt: c.t, id: c.i };
    case 'top':
      return { sort: 'top', upvoteCount: c.v, id: c.i };
    case 'unanswered':
      return { sort: 'unanswered', createdAt: c.t, id: c.i };
  }
}

function invalidCursor(): ValidationError {
  return new ValidationError('Invalid cursor.', {
    code: ErrorCode.ValidationFailed,
    issues: [{ path: 'cursor', message: 'Invalid cursor.' }],
  });
}
