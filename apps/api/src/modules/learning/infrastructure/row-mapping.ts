import { sql } from '@udemy/db';

/**
 * A timestamp column as exact UTC text with microseconds (`2026-10-24T12:00:00.123456Z`): the
 * keyset cursor value (P2 §14). A JS Date drops the microseconds, so a cursor built from it
 * would skip or repeat rows.
 */
export function exactUtcText(columnRef: string) {
  return sql<string>`to_char(${sql.ref(columnRef)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
