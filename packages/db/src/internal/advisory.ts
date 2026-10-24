/**
 * Two-int advisory mutexes (the `'mqta'` convention of media/quota.ts): the first key is a
 * 4-ASCII-char class constant, so the class is readable in `pg_locks.classid`; the second key is
 * `hashtext(...)` of the entity. Two-int keys never collide with the single-bigint job keys.
 */
import { type RawBuilder, sql } from 'kysely';
import { type Executor, requireTransaction } from '../transaction';

/** The int4 value of a 4-char ASCII class name, e.g. `'lrnc'` -> 1819438691 (big-endian). */
export function asciiLockClass(name: string): number {
  if (!/^[\x20-\x7e]{4}$/.test(name)) {
    throw new RangeError(`lock class must be 4 printable ASCII characters, got ${name}`);
  }
  return Buffer.from(name, 'ascii').readInt32BE(0);
}

/**
 * Canonical text of one or more uuids joined by ':' (`::uuid::text` lower-cases and validates,
 * so two callers that format the same id differently still hash to the same key).
 */
export function uuidLockKey(...ids: string[]): RawBuilder<string> {
  const parts = ids.map((id) => sql`${id}::uuid::text`);
  return sql<string>`${sql.join(parts, sql` || ':' || `)}`;
}

/** `pg_advisory_xact_lock(class, hashtext(key))`; waits; released at COMMIT/ROLLBACK. */
export async function advisoryXactLock2(
  executor: Executor,
  lockClass: number,
  key: RawBuilder<string>,
  what: string,
): Promise<void> {
  const trx = requireTransaction(executor, what);
  await sql`SELECT pg_advisory_xact_lock(${lockClass}::int, hashtext(${key}))`.execute(trx);
}
