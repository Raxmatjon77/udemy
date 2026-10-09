import { type Kysely, sql } from 'kysely';

/**
 * Phase 0 foundation: extensions, bounded-context schemas, transactional outbox.
 * Domain tables arrive in later migrations. Migrations use `Kysely<any>` on
 * purpose: they must not depend on the (evolving) generated DB type.
 *
 * UUIDv7 note: `uuidv7()` is built in since PostgreSQL 18. On PG <= 17 define a
 * fallback function before this migration (e.g. the pg_uuidv7 extension).
 */
const SCHEMAS = [
  'identity',
  'access',
  'catalog',
  'media',
  'commerce',
  'enrollment',
  'learning',
  'engagement',
  'payouts',
  'notifications',
  'messaging',
  'audit',
  'analytics',
  'outbox',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS citext`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  for (const schema of SCHEMAS) {
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(schema)}`.execute(db);
  }

  await sql`
    CREATE TABLE outbox.events (
      id             uuid        PRIMARY KEY DEFAULT uuidv7(),
      aggregate_type text        NOT NULL,
      aggregate_id   text        NOT NULL,
      type           text        NOT NULL,
      payload        jsonb       NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX events_created_at_idx ON outbox.events (created_at)`.execute(db);
  await sql`
    COMMENT ON TABLE outbox.events IS
      'Transactional outbox. Written in the same transaction as the domain change. Debezium reads it via the dbz_outbox publication and the EventRouter SMT (aggregate_type -> topic, aggregate_id -> key). Debezium reads the WAL, not the table, so rows may be deleted by a periodic cleanup job once captured.'
  `.execute(db);

  await sql`
    CREATE TABLE outbox.processed_events (
      consumer     text        NOT NULL,
      event_id     uuid        NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE outbox.processed_events IS
      'Idempotent Kafka consumers insert (consumer, event_id) first; a conflict means the event was already handled.'
  `.execute(db);

  // CREATE PUBLICATION has no IF NOT EXISTS, so guard via pg_publication.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'dbz_outbox') THEN
        CREATE PUBLICATION dbz_outbox FOR TABLE outbox.events;
      END IF;
    END
    $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END
    $$
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS public.set_updated_at()`.execute(db);
  await sql`DROP PUBLICATION IF EXISTS dbz_outbox`.execute(db);
  await sql`DROP TABLE IF EXISTS outbox.processed_events`.execute(db);
  await sql`DROP TABLE IF EXISTS outbox.events`.execute(db);
  // Schemas are dropped WITHOUT cascade: if a later migration's objects remain, fail loudly.
  for (const schema of [...SCHEMAS].reverse()) {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)}`.execute(db);
  }
  await sql`DROP EXTENSION IF EXISTS pg_trgm`.execute(db);
  await sql`DROP EXTENSION IF EXISTS citext`.execute(db);
}
