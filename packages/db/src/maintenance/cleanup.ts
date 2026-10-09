/**
 * Batched retention cleanup for the identity schema (docs/phase-1-schema-design.md §8).
 *
 * Each function runs ONE batch and returns the number of rows it deleted. The caller
 * (worker, task T9) loops until a batch returns fewer rows than `batchSize`, and gives
 * each batch its own transaction (optionally guarded by `pg_try_advisory_xact_lock`).
 *
 * All candidate rows are picked with `FOR UPDATE SKIP LOCKED`, so concurrent workers and
 * live refreshes are never blocked. Timestamps are compared against SQL `now()`.
 */
import { sql } from 'kysely';
import type { Executor } from '../transaction';

export interface CleanupBatchOptions {
  /** Grace period in days after expiry/revocation before rows are deleted (suggested: 7). */
  graceDays: number;
  /** Max rows per statement (suggested: 5000 for tokens, 500 for sessions). */
  batchSize: number;
}

export interface SessionCleanupResult {
  /** Sessions past `absolute_expires_at` + grace. */
  absoluteExpired: number;
  /** Revoked sessions past `revoked_at` + grace. */
  revoked: number;
  /** Sessions whose current refresh token expired more than `graceDays` ago. */
  idleExpired: number;
}

/** Same upper bound as identity.purge_security_events, so callers can't do unbounded deletes. */
const MAX_BATCH_SIZE = 50_000;

function assertOptions({ graceDays, batchSize }: CleanupBatchOptions): void {
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new RangeError(`graceDays must be a non-negative integer, got ${graceDays}`);
  }
  assertBatchSize(batchSize);
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer in 1..${MAX_BATCH_SIZE}, got ${batchSize}`);
  }
}

/** `now() - graceDays days`; `::int` is required when bound as a parameter. */
function cutoff(graceDays: number) {
  return sql<Date>`now() - make_interval(days => ${graceDays}::int)`;
}

/**
 * §8 A: consumed refresh tokens whose `expires_at` is older than the grace period.
 * Current (unconsumed) tokens are removed together with their session. A deleted
 * parent only nulls its child's `parent_id` (FK `ON DELETE SET NULL (parent_id)`).
 */
export async function deleteConsumedRefreshTokens(
  executor: Executor,
  options: CleanupBatchOptions,
): Promise<number> {
  assertOptions(options);
  const result = await executor
    .with('doomed', (qb) =>
      qb
        .selectFrom('identity.refreshTokens')
        .select('id')
        .where('consumedAt', 'is not', null)
        .where('expiresAt', '<', cutoff(options.graceDays))
        .orderBy('expiresAt')
        .limit(options.batchSize)
        .forUpdate()
        .skipLocked(),
    )
    .deleteFrom('identity.refreshTokens as rt')
    .using('doomed')
    .whereRef('rt.id', '=', 'doomed.id')
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * §8 B1–B3: expired and revoked sessions. Deleting a session cascades to all of its
 * refresh tokens. Runs the three statements in order and returns one count each.
 * B3 selects and locks the current token first, then deletes the session, which is the
 * same lock order as the refresh flow (token, then session), so it can't deadlock with it.
 */
export async function deleteExpiredSessions(
  executor: Executor,
  options: CleanupBatchOptions,
): Promise<SessionCleanupResult> {
  assertOptions(options);
  const { graceDays, batchSize } = options;

  const absoluteExpired = await executor
    .with('doomed', (qb) =>
      qb
        .selectFrom('identity.sessions')
        .select('id')
        .where('absoluteExpiresAt', '<', cutoff(graceDays))
        .orderBy('absoluteExpiresAt')
        .limit(batchSize)
        .forUpdate()
        .skipLocked(),
    )
    .deleteFrom('identity.sessions as s')
    .using('doomed')
    .whereRef('s.id', '=', 'doomed.id')
    .executeTakeFirst();

  const revoked = await executor
    .with('doomed', (qb) =>
      qb
        .selectFrom('identity.sessions')
        .select('id')
        .where('revokedAt', 'is not', null)
        .where('revokedAt', '<', cutoff(graceDays))
        .orderBy('revokedAt')
        .limit(batchSize)
        .forUpdate()
        .skipLocked(),
    )
    .deleteFrom('identity.sessions as s')
    .using('doomed')
    .whereRef('s.id', '=', 'doomed.id')
    .executeTakeFirst();

  const idleExpired = await executor
    .with('doomed', (qb) =>
      qb
        .selectFrom('identity.refreshTokens as rt')
        .select('rt.sessionId as id')
        .where('rt.consumedAt', 'is', null)
        .where('rt.expiresAt', '<', cutoff(graceDays))
        .orderBy('rt.expiresAt')
        .limit(batchSize)
        .forUpdate()
        .skipLocked(),
    )
    .deleteFrom('identity.sessions as s')
    .using('doomed')
    .whereRef('s.id', '=', 'doomed.id')
    .executeTakeFirst();

  return {
    absoluteExpired: Number(absoluteExpired.numDeletedRows),
    revoked: Number(revoked.numDeletedRows),
    idleExpired: Number(idleExpired.numDeletedRows),
  };
}

/**
 * §8 C: one-time tokens that expired more than `graceDays` ago. Every consumed or
 * invalidated token has `expires_at <= requested_at + TTL`, so this one index-driven
 * predicate removes them all; live, unexpired tokens are never touched.
 */
export async function deleteExpiredOneTimeTokens(
  executor: Executor,
  options: CleanupBatchOptions,
): Promise<number> {
  assertOptions(options);
  const result = await executor
    .with('doomed', (qb) =>
      qb
        .selectFrom('identity.oneTimeTokens')
        .select('id')
        .where('expiresAt', '<', cutoff(options.graceDays))
        .orderBy('expiresAt')
        .limit(options.batchSize)
        .forUpdate()
        .skipLocked(),
    )
    .deleteFrom('identity.oneTimeTokens as t')
    .using('doomed')
    .whereRef('t.id', '=', 'doomed.id')
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * §8 D: security_events older than 180 days, through the SECURITY DEFINER function
 * (the only delete path the append-only trigger and the prod grants allow).
 * The retention window is fixed in the database, so there is no `graceDays` here.
 */
export async function purgeSecurityEvents(executor: Executor, batchSize: number): Promise<number> {
  assertBatchSize(batchSize);
  const { rows } = await sql<{
    deleted: number;
  }>`SELECT identity.purge_security_events(${batchSize}::int) AS deleted`.execute(executor);
  return rows[0]?.deleted ?? 0;
}
