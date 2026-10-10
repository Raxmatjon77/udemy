import { basename } from 'node:path';
import { type Kysely, sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { createDatabase } from '../database';
import type { DB } from '../generated/db';

/**
 * The ONE convention for @udemy/db integration tests (real Postgres), mirroring
 * apps/api/src/testing/integration.ts:
 *
 * - `IT_DATABASE_URL`, defaulting to the dev compose stack (Postgres on 55432).
 * - Locally, an unreachable or unmigrated database SKIPS the tests with a clear message.
 * - With `CI=true` it FAILS: CI must never go green by silently skipping.
 * - A database that accepts the connection but does not answer within PROBE_TIMEOUT_MS always FAILS.
 * - Every test owns its data: it runs in a transaction that is rolled back (`rollback()`), or it
 *   commits rows that belong to users it created and `deleteTestData()` removes in afterAll
 *   (append-only tables can't be truncated; cleanup uses `session_replication_role = replica`,
 *   which needs a superuser, as in dev and CI).
 *
 * The migrations must have been applied (`pnpm --filter @udemy/db migrate:latest`).
 */
export const IT_DEFAULT_DATABASE_URL = 'postgres://udemy:udemy@localhost:55432/udemy';
export const PROBE_TIMEOUT_MS = 25_000;

export function itDatabaseUrl(): string {
  const value = process.env.IT_DATABASE_URL;
  return value === undefined || value.trim() === '' ? IT_DEFAULT_DATABASE_URL : value.trim();
}

export function isCi(): boolean {
  return process.env.CI === 'true';
}

export interface SkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface IntegrationDb {
  /** Throws when the database is unavailable. */
  readonly db: Kysely<DB>;
  readonly unavailableReason: string | undefined;
  /** Call first in every test. */
  skipIfUnavailable(ctx: SkippableContext): void;
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparsable url>';
  }
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0)
    return describeError(error.errors[0]);
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

class ProbeTimeout extends Error {}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeout(`Postgres probe timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Registers beforeAll/afterAll: connect + probe a 0003 table, then close the pool. */
export function useIntegrationDb(options: { max?: number } = {}): IntegrationDb {
  const url = itDatabaseUrl();
  let db: Kysely<DB> | undefined;
  let reason: string | undefined = 'not connected yet (used outside a test?)';

  beforeAll(async () => {
    const testPath = expect.getState().testPath;
    db = createDatabase({
      connectionString: url,
      max: options.max ?? 6,
      applicationName: testPath === undefined ? 'udemy-db-it' : `udemy-db-it:${basename(testPath)}`,
    });
    try {
      await withDeadline(
        sql`select 1 from media.transcode_attempts limit 0`.execute(db),
        PROBE_TIMEOUT_MS,
      );
      reason = undefined;
    } catch (error) {
      const message = `Postgres unavailable at ${redact(url)} (IT_DATABASE_URL): ${describeError(error)}`;
      // A stalled server, or CI: fail loudly. Locally, unreachable/unmigrated: skip.
      if (error instanceof ProbeTimeout || isCi()) throw new Error(message, { cause: error });
      reason = message;
    }
  });

  afterAll(async () => {
    await db?.destroy();
  });

  return {
    get db() {
      if (db === undefined || reason !== undefined) {
        throw new Error(reason ?? 'database not connected');
      }
      return db;
    },
    get unavailableReason() {
      return reason;
    },
    skipIfUnavailable(ctx) {
      ctx.skip(reason !== undefined, reason);
    },
  };
}

class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back; returns fn's result. */
export async function rollback<T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction().execute(async (trx) => {
      result = await fn(trx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

export interface PgErrorShape {
  code?: string;
  constraint?: string;
}

/**
 * Runs `fn` inside a SAVEPOINT of `trx`, expects it to fail, rolls back to the savepoint (so the
 * transaction stays usable) and returns the error.
 */
export async function expectFailure(
  trx: Transaction<DB>,
  fn: () => Promise<unknown>,
): Promise<PgErrorShape & Error> {
  await sql`SAVEPOINT it_expect`.execute(trx);
  try {
    await fn();
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT it_expect`.execute(trx);
    return error as PgErrorShape & Error;
  }
  await sql`RELEASE SAVEPOINT it_expect`.execute(trx);
  throw new Error('expected the statement to fail, but it succeeded');
}

/** Forces every deferred constraint/trigger of the transaction to run now (as COMMIT would). */
export async function checkDeferredNow(trx: Transaction<DB>): Promise<void> {
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx);
  await sql`SET CONSTRAINTS ALL DEFERRED`.execute(trx);
}

/** Backend pid of the connection running `executor` (a transaction pins one connection). */
export async function backendPid(trx: Transaction<DB>): Promise<number> {
  const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
  return rows[0]!.pid;
}

/** Polls pg_stat_activity until `pid` waits on a lock (proves the expected blocking). */
export async function waitUntilBlocked(
  db: Kysely<DB>,
  pid: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await sql<{ waitEventType: string | null }>`
      select wait_event_type from pg_stat_activity where pid = ${pid}
    `.execute(db);
    if (rows[0]?.waitEventType === 'Lock') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`backend ${pid} did not block on a lock within ${timeoutMs} ms`);
}

/** A promise you resolve from outside: orchestrates two concurrent transactions. */
export function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Deletes everything the tests committed for these users (their assets with jobs, attempts,
 * renditions and usages; their courses with all catalog children and history; categories by id;
 * then the users). `session_replication_role = replica` disables the append-only triggers and FK
 * checks for this transaction only; it needs a superuser (dev compose and CI connect as one).
 */
export async function deleteTestData(
  db: Kysely<DB>,
  userIds: readonly string[],
  categoryIds: readonly string[] = [],
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0 && categoryIds.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (ids.length > 0) {
      await sql`
        WITH a AS (SELECT id FROM media.assets WHERE owner_id = ANY(${ids}::uuid[]))
        , d1 AS (DELETE FROM media.transcode_attempts WHERE asset_id IN (SELECT id FROM a))
        , d2 AS (DELETE FROM media.transcode_jobs WHERE asset_id IN (SELECT id FROM a))
        , d3 AS (DELETE FROM media.asset_renditions WHERE asset_id IN (SELECT id FROM a))
        , d4 AS (DELETE FROM media.asset_usages WHERE asset_id IN (SELECT id FROM a))
        DELETE FROM media.assets WHERE id IN (SELECT id FROM a)
      `.execute(trx);
      await sql`
        WITH c AS (SELECT id FROM catalog.courses WHERE owner_id = ANY(${ids}::uuid[]))
        , r AS (SELECT id FROM catalog.course_revisions WHERE course_id IN (SELECT id FROM c))
        , d1 AS (DELETE FROM catalog.course_transitions WHERE course_id IN (SELECT id FROM c))
        , d2 AS (DELETE FROM catalog.revision_lectures WHERE revision_id IN (SELECT id FROM r))
        , d3 AS (DELETE FROM catalog.revision_sections WHERE revision_id IN (SELECT id FROM r))
        , d4 AS (DELETE FROM catalog.revision_bullets WHERE revision_id IN (SELECT id FROM r))
        , d5 AS (DELETE FROM catalog.course_revisions WHERE id IN (SELECT id FROM r))
        , d6 AS (DELETE FROM catalog.lecture_articles WHERE lecture_id IN
                   (SELECT id FROM catalog.lectures WHERE course_id IN (SELECT id FROM c)))
        , d7 AS (DELETE FROM catalog.lectures WHERE course_id IN (SELECT id FROM c))
        , d8 AS (DELETE FROM catalog.sections WHERE course_id IN (SELECT id FROM c))
        , d9 AS (DELETE FROM catalog.course_bullets WHERE course_id IN (SELECT id FROM c))
        DELETE FROM catalog.courses WHERE id IN (SELECT id FROM c)
      `.execute(trx);
    }
    if (categoryIds.length > 0) {
      await trx
        .deleteFrom('catalog.categories')
        .where('id', 'in', [...categoryIds])
        .execute();
    }
    if (ids.length > 0) {
      await trx.deleteFrom('outbox.events').where('aggregateId', 'in', ids).execute();
      await trx.deleteFrom('identity.users').where('id', 'in', ids).execute();
    }
  });
}
