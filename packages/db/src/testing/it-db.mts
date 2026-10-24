import { basename } from 'node:path';
import { type Kysely, sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { createDatabase } from '../database.js';
import type { DB } from '../generated/db.js';

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

/** Registers beforeAll/afterAll: connect + probe the newest migration's table (0004), then close the pool. */
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
      await withDeadline(sql`select 1 from payouts.postings limit 0`.execute(db), PROBE_TIMEOUT_MS);
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

/** Name of the Phase 5 migration (learning / engagement / notifications + catalog QUIZ). */
export const PHASE5_MIGRATION = '2026_10_24_0005_learning_engagement_notifications';

/**
 * Skips the test locally, or FAILS it with CI=true, unless migration `name` is applied (the
 * harness only probes the 0004 tables). Call right after `skipIfUnavailable`.
 */
export async function skipUnlessMigrated(
  pg: IntegrationDb,
  ctx: SkippableContext,
  name: string = PHASE5_MIGRATION,
): Promise<void> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM public.kysely_migration WHERE name = ${name}
  `.execute(pg.db);
  const applied = rows[0]!.n === 1;
  if (!applied && isCi()) throw new Error(`migration ${name} is not applied`);
  ctx.skip(!applied, `${name} not applied (run pnpm --filter @udemy/db migrate:latest)`);
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

/**
 * Runs `fn` plus every deferred check (as COMMIT would) in a rolled-back transaction and returns
 * the error. One failing invariant per call: a failed SET CONSTRAINTS leaves its events queued.
 */
export async function deferredFailure(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<unknown>,
): Promise<PgErrorShape & Error> {
  try {
    await rollback(db, async (trx) => {
      await fn(trx);
      await checkDeferredNow(trx);
    });
  } catch (error) {
    return error as PgErrorShape & Error;
  }
  throw new Error('expected a deferred constraint to fail, but every check passed');
}

/** Same, but `fn` must pass every deferred check (still rolled back). Returns fn's result. */
export async function deferredOk<T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return rollback(db, async (trx) => {
    const result = await fn(trx);
    await checkDeferredNow(trx);
    return result;
  });
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
 * Phase 4 rows of these users (as buyer, instructor, coupon creator, price author or payee),
 * plus the given provider events. Runs inside deleteTestData's replica-role transaction: the
 * append-only and guard triggers and the FK checks are off, so order doesn't matter.
 */
async function deleteCommerceRows(
  trx: Transaction<DB>,
  ids: readonly string[],
  eventIds: readonly string[],
): Promise<void> {
  const u = sql`${[...ids]}::uuid[]`;
  const orders = sql`
    SELECT id FROM commerce.orders WHERE user_id = ANY(${u})
    UNION SELECT order_id FROM commerce.order_lines WHERE instructor_id = ANY(${u})`;
  const lines = sql`SELECT id FROM commerce.order_lines WHERE order_id IN (${orders})`;
  const refunds = sql`SELECT id FROM commerce.refunds WHERE order_id IN (${orders})`;
  const coupons = sql`SELECT id FROM commerce.coupons WHERE created_by = ANY(${u}) OR deactivated_by = ANY(${u})`;
  const entries = sql`SELECT id FROM payouts.journal_entries WHERE order_line_id IN (${lines})`;
  await sql`
    DELETE FROM payouts.postings WHERE entry_id IN (${entries})
       OR account_id IN (SELECT id FROM payouts.accounts WHERE owner_id = ANY(${u}))
  `.execute(trx);
  await sql`DELETE FROM payouts.journal_entries WHERE order_line_id IN (${lines})`.execute(trx);
  await sql`DELETE FROM payouts.accounts WHERE owner_id = ANY(${u})`.execute(trx);
  await sql`
    DELETE FROM enrollment.enrollment_transitions
     WHERE enrollment_id IN (SELECT id FROM enrollment.enrollments WHERE user_id = ANY(${u})) OR actor_id = ANY(${u})
  `.execute(trx);
  await sql`DELETE FROM enrollment.enrollments WHERE user_id = ANY(${u})`.execute(trx);
  const events = sql`
    SELECT provider_event_id FROM commerce.order_transitions WHERE order_id IN (${orders}) AND provider_event_id IS NOT NULL
    UNION SELECT provider_event_id FROM commerce.refund_transitions WHERE refund_id IN (${refunds}) AND provider_event_id IS NOT NULL
    UNION SELECT event_id FROM commerce.provider_events WHERE order_id IN (${orders})
    UNION SELECT unnest(${[...eventIds]}::text[])`;
  const eventList = await sql<{
    id: string;
  }>`SELECT DISTINCT e AS id FROM (${events}) x(e)`.execute(trx);
  await sql`DELETE FROM commerce.refund_transitions WHERE refund_id IN (${refunds})`.execute(trx);
  await sql`DELETE FROM commerce.refunds WHERE order_id IN (${orders})`.execute(trx);
  await sql`DELETE FROM commerce.order_transitions WHERE order_id IN (${orders})`.execute(trx);
  await sql`
    DELETE FROM commerce.provider_events WHERE provider = 'STRIPE' AND event_id = ANY(${eventList.rows.map((r) => r.id)}::text[])
  `.execute(trx);
  await sql`DELETE FROM commerce.payments WHERE order_id IN (${orders})`.execute(trx);
  await sql`
    DELETE FROM commerce.coupon_redemptions WHERE order_id IN (${orders}) OR coupon_id IN (${coupons})
  `.execute(trx);
  await sql`DELETE FROM commerce.order_lines WHERE order_id IN (${orders})`.execute(trx);
  await sql`DELETE FROM commerce.orders WHERE id IN (${orders})`.execute(trx);
  await sql`DELETE FROM commerce.coupons WHERE id IN (${coupons})`.execute(trx);
  await sql`DELETE FROM commerce.cart_items WHERE user_id = ANY(${u})`.execute(trx);
  await sql`DELETE FROM commerce.carts WHERE user_id = ANY(${u})`.execute(trx);
  await sql`
    DELETE FROM commerce.course_price_changes
     WHERE changed_by = ANY(${u}) OR course_id IN (SELECT course_id FROM commerce.course_prices WHERE updated_by = ANY(${u}))
  `.execute(trx);
  await sql`DELETE FROM commerce.course_prices WHERE updated_by = ANY(${u})`.execute(trx);
}

/**
 * Phase 5 rows (0005) of these users: learning progress/completions/attempts/notes/certificates,
 * their engagement content (with the votes, reports and moderation rows on it), notifications,
 * and the catalog quiz tables of their courses. A no-op on a database without 0005. Runs inside
 * deleteTestData's replica-role transaction (FK checks and guards are off). Fan-out jobs and
 * course_rating_stats rows are not user-linked: tests delete their own.
 */
async function deletePhase5Rows(trx: Transaction<DB>, ids: readonly string[]): Promise<void> {
  const { rows } = await sql<{ present: boolean }>`
    SELECT to_regclass('learning.lecture_progress') IS NOT NULL AS present
  `.execute(trx);
  if (rows[0]?.present !== true) return;
  const u = sql`${[...ids]}::uuid[]`;
  await sql`
    WITH att AS (SELECT id FROM learning.quiz_attempts WHERE user_id = ANY(${u}))
    , cert AS (SELECT id FROM learning.certificates WHERE user_id = ANY(${u}))
    , d1 AS (DELETE FROM learning.quiz_attempt_selections WHERE attempt_id IN (SELECT id FROM att))
    , d2 AS (DELETE FROM learning.quiz_attempt_questions WHERE attempt_id IN (SELECT id FROM att))
    , d3 AS (DELETE FROM learning.lecture_completions WHERE user_id = ANY(${u}))
    , d4 AS (DELETE FROM learning.quiz_attempts WHERE id IN (SELECT id FROM att))
    , d5 AS (DELETE FROM learning.certificate_transitions
              WHERE certificate_id IN (SELECT id FROM cert) OR actor_id = ANY(${u}))
    , d6 AS (DELETE FROM learning.certificates WHERE id IN (SELECT id FROM cert))
    , d7 AS (DELETE FROM learning.course_completions WHERE user_id = ANY(${u}))
    , d8 AS (DELETE FROM learning.notes WHERE user_id = ANY(${u}))
    , d9 AS (DELETE FROM learning.course_activity WHERE user_id = ANY(${u}))
    DELETE FROM learning.lecture_progress WHERE user_id = ANY(${u})
  `.execute(trx);
  await sql`
    WITH q AS (SELECT id FROM engagement.questions WHERE author_id = ANY(${u}))
    , a AS (SELECT id FROM engagement.answers WHERE author_id = ANY(${u}) OR question_id IN (SELECT id FROM q))
    , r AS (SELECT id FROM engagement.reviews WHERE user_id = ANY(${u}) OR deleted_by = ANY(${u}))
    , rr AS (SELECT id FROM engagement.review_replies WHERE author_id = ANY(${u}) OR review_id IN (SELECT id FROM r))
    , subj AS (SELECT id FROM q UNION ALL SELECT id FROM a UNION ALL SELECT id FROM r UNION ALL SELECT id FROM rr)
    , d1 AS (DELETE FROM engagement.question_votes WHERE user_id = ANY(${u}) OR subject_id IN (SELECT id FROM q))
    , d2 AS (DELETE FROM engagement.answer_votes WHERE user_id = ANY(${u}) OR subject_id IN (SELECT id FROM a))
    , d3 AS (DELETE FROM engagement.question_reports
              WHERE reporter_id = ANY(${u}) OR resolved_by = ANY(${u}) OR subject_id IN (SELECT id FROM q))
    , d4 AS (DELETE FROM engagement.answer_reports
              WHERE reporter_id = ANY(${u}) OR resolved_by = ANY(${u}) OR subject_id IN (SELECT id FROM a))
    , d5 AS (DELETE FROM engagement.review_reports
              WHERE reporter_id = ANY(${u}) OR resolved_by = ANY(${u}) OR subject_id IN (SELECT id FROM r))
    , d6 AS (DELETE FROM engagement.review_reply_reports
              WHERE reporter_id = ANY(${u}) OR resolved_by = ANY(${u}) OR subject_id IN (SELECT id FROM rr))
    , d7 AS (DELETE FROM engagement.moderation_actions
              WHERE actor_id = ANY(${u}) OR subject_id IN (SELECT id FROM subj))
    , d8 AS (DELETE FROM engagement.answers WHERE id IN (SELECT id FROM a))
    , d9 AS (DELETE FROM engagement.review_replies WHERE id IN (SELECT id FROM rr))
    , d10 AS (DELETE FROM engagement.reviews WHERE id IN (SELECT id FROM r))
    , d11 AS (DELETE FROM engagement.announcements WHERE author_id = ANY(${u}) OR deleted_by = ANY(${u}))
    , d12 AS (DELETE FROM engagement.wishlist_items WHERE user_id = ANY(${u}))
    DELETE FROM engagement.questions WHERE id IN (SELECT id FROM q)
  `.execute(trx);
  await sql`
    WITH d1 AS (DELETE FROM notifications.notification_preferences WHERE user_id = ANY(${u}))
    DELETE FROM notifications.notifications WHERE user_id = ANY(${u})
  `.execute(trx);
  await sql`
    WITH c AS (SELECT id FROM catalog.courses WHERE owner_id = ANY(${u}))
    , r AS (SELECT id FROM catalog.course_revisions WHERE course_id IN (SELECT id FROM c))
    , l AS (SELECT id FROM catalog.lectures WHERE course_id IN (SELECT id FROM c))
    , qq AS (SELECT id FROM catalog.quiz_questions WHERE lecture_id IN (SELECT id FROM l))
    , d1 AS (DELETE FROM catalog.revision_quiz_options WHERE revision_id IN (SELECT id FROM r))
    , d2 AS (DELETE FROM catalog.revision_quiz_questions WHERE revision_id IN (SELECT id FROM r))
    , d3 AS (DELETE FROM catalog.quiz_options WHERE question_id IN (SELECT id FROM qq))
    , d4 AS (DELETE FROM catalog.quiz_questions WHERE id IN (SELECT id FROM qq))
    DELETE FROM catalog.lecture_quizzes WHERE lecture_id IN (SELECT id FROM l)
  `.execute(trx);
}

/**
 * Deletes everything the tests committed for these users (their Phase 5 learning / engagement /
 * notifications rows; their commerce / enrollment / payouts rows and `providerEventIds`; their
 * assets with jobs, attempts, renditions and usages; their courses with all catalog children,
 * quiz tables and history; categories by id; then the users).
 * `session_replication_role = replica` disables the append-only triggers and FK checks for this
 * transaction only; it needs a superuser (dev compose and CI connect as one).
 */
export async function deleteTestData(
  db: Kysely<DB>,
  userIds: readonly string[],
  categoryIds: readonly string[] = [],
  options: { providerEventIds?: readonly string[] } = {},
): Promise<void> {
  const ids = [...new Set(userIds)];
  const eventIds = [...new Set(options.providerEventIds ?? [])];
  if (ids.length === 0 && categoryIds.length === 0 && eventIds.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (ids.length > 0) await deletePhase5Rows(trx, ids);
    if (ids.length > 0 || eventIds.length > 0) await deleteCommerceRows(trx, ids, eventIds);
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
