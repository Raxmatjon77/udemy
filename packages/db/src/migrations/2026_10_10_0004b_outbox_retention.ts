import { type Kysely, type RawBuilder, sql } from 'kysely';

/**
 * Phase 3 hardening (orchestrator request with P4-T6), kept separate from 0004 so it can be
 * reverted on its own. Supports the worker's OutboxRetentionJob (advisory lock `0x75646d79_10`):
 *
 * 1. `processed_events_processed_at_idx`: the job deletes `outbox.processed_events` older than
 *    30 days in batches (`WHERE processed_at < $cutoff ... LIMIT n`), which seq-scanned before.
 *    Plain CREATE INDEX (Kysely runs a migration in a transaction, so CONCURRENTLY is impossible);
 *    it blocks writes to processed_events only while it builds. On a large prod table, build it
 *    CONCURRENTLY by hand first: `IF NOT EXISTS` then makes this statement a no-op.
 * 2. `dbz_outbox` publishes INSERTs only: the job DELETEs captured rows from `outbox.events`, and
 *    Debezium would otherwise decode every delete just for the EventRouter to drop it. The
 *    `udemy-outbox` connector config is unchanged (pgoutput re-reads the publication options).
 *    down() restores the 0001 setting (CREATE PUBLICATION's default: all four operations).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(db: Kysely<any>, statements: RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) {
    await statement.execute(db);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await run(db, [
    sql`CREATE INDEX IF NOT EXISTS processed_events_processed_at_idx ON outbox.processed_events (processed_at)`,
    sql`ALTER PUBLICATION dbz_outbox SET (publish = 'insert')`,
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await run(db, [
    sql`ALTER PUBLICATION dbz_outbox SET (publish = 'insert, update, delete, truncate')`,
    sql`DROP INDEX IF EXISTS outbox.processed_events_processed_at_idx`,
  ]);
}
