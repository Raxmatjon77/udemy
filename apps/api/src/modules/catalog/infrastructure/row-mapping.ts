import { sql } from '@udemy/db';

/** Narrows a CHECK-constrained text column to its contract union (a mismatch is a bug: 500). */
export function narrow<T extends string>(values: readonly T[], value: string, column: string): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${column} value "${value}"`);
}

export function narrowNullable<T extends string>(
  values: readonly T[],
  value: string | null,
  column: string,
): T | null {
  return value === null ? null : narrow(values, value, column);
}

/**
 * A timestamptz column (`alias.column`, a trusted identifier) as exact ISO-8601 UTC text WITH
 * microseconds, for keyset cursors (design §14: a JS Date keeps only milliseconds).
 */
export function exactUtcText(columnRef: string) {
  return sql<string>`to_char(${sql.ref(columnRef)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
