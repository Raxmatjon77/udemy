/**
 * Database factory for the whole monorepo.
 *
 * Conventions (important, read once):
 * - CamelCasePlugin: DB columns/tables are snake_case, TypeScript is camelCase.
 *   Write `db.selectFrom("outbox.events").select("createdAt")`; SQL sees `created_at`.
 *   Caveat: the plugin also camel-cases keys of plain objects in RESULTS, including
 *   jsonb contents. Don't rely on snake_case keys inside jsonb columns you read back.
 * - numeric -> string. Money is `numeric(12,2)`; parsing to float loses precision.
 *   Use a decimal library / integer minor units in the domain layer.
 * - int8 (bigint, count(*)) -> string. `bigint` would need a BigInt-aware JSON
 *   serializer everywhere (HTTP, Kafka); strings are safe and lossless.
 * - timestamptz -> Date (pg default).
 */
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from './generated/db';

export interface CreateDatabaseOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

const PG_INT8 = 20;
const PG_NUMERIC = 1700;
const PG_TIMESTAMPTZ = 1184;

/** Per-pool parsers, so we never mutate the global `pg.types`. */
const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === PG_INT8 || oid === PG_NUMERIC) return (v: string) => v;
    if (oid === PG_TIMESTAMPTZ) return (v: string) => new Date(v);
    return types.getTypeParser(oid, format as 'text');
  },
};

export function createDatabase(opts: CreateDatabaseOptions): Kysely<DB> {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName,
    types: typeParsers,
  });
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
