import { PAGE_LIMIT_MAX } from '@udemy/contracts';
import { z } from 'zod';
import { InvalidSearchParameter } from '../domain/identity.errors';
import type { UserKeyset } from './ports/user-directory';

/** Trigram indexes only help from 3 characters on (schema doc §6). */
export const SEARCH_MIN_QUERY_LENGTH = 3;
const SEARCH_MAX_QUERY_LENGTH = 254;

/** `created_at` with microseconds: the keyset must not lose the sub-millisecond part. */
const KeysetSchema = z.object({
  c: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});

/** Opaque cursor: base64url of `{ c: createdAt, i: id }` of the last row of a page. */
export function encodeUserCursor(keyset: UserKeyset): string {
  return Buffer.from(JSON.stringify({ c: keyset.createdAt, i: keyset.id }), 'utf8').toString(
    'base64url',
  );
}

/** @throws InvalidSearchParameter (422) for anything this api did not produce */
export function decodeUserCursor(cursor: string): UserKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidSearchParameter('cursor', 'Invalid cursor.');
  }
  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) throw new InvalidSearchParameter('cursor', 'Invalid cursor.');
  return { createdAt: result.data.c, id: result.data.i };
}

/** `%` `_` `\` are LIKE metacharacters (backslash is PostgreSQL's default LIKE escape). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Substring pattern for `ILIKE`, or undefined for no text filter. */
export function searchPattern(q: string | undefined): string | undefined {
  if (q === undefined) return undefined;
  const value = q.trim();
  if (value === '') return undefined;
  if ([...value].length < SEARCH_MIN_QUERY_LENGTH || value.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new InvalidSearchParameter(
      'q',
      `The search text must be ${SEARCH_MIN_QUERY_LENGTH}–${SEARCH_MAX_QUERY_LENGTH} characters.`,
    );
  }
  return `%${escapeLikePattern(value)}%`;
}

export function assertPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
    throw new InvalidSearchParameter('limit', `The limit must be between 1 and ${PAGE_LIMIT_MAX}.`);
  }
}
