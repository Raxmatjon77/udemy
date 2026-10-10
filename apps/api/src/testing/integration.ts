import { basename } from 'node:path';
import { createDatabase, type DB, type Kysely, sql } from '@udemy/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect } from 'vitest';

/**
 * The ONE convention for api integration tests (real Postgres / Redis):
 *
 * - `IT_DATABASE_URL` / `IT_REDIS_URL`, defaulting to the dev compose stack
 *   (infra/docker/docker-compose.dev.yml: Postgres on 55432, Redis on 56379).
 * - Locally, an unreachable dependency SKIPS the tests with a clear message.
 * - With `CI=true` (set by GitLab CI), an unreachable dependency FAILS the suite: CI must never
 *   go green by silently skipping its integration tests.
 * - A dependency that accepts the connection but does not answer within PROBE_TIMEOUT_MS
 *   (an overloaded host / Docker VM, or a lock held by a running migration) always FAILS with a
 *   message saying so: it is running, so skipping would hide the problem, and an unbounded wait
 *   would only surface as vitest's anonymous "Hook timed out".
 * - Files named `*.integration.spec.ts` / `*.e2e.spec.ts` run one at a time (the `integration`
 *   project in vitest.config.mts). Still, every file must own its data: fresh ids/emails, Redis
 *   keys under its own prefix, and no global FLUSH*: other processes share the dev stack.
 *
 *   const pg = useIntegrationDatabase();
 *   it('...', async (ctx) => {
 *     pg.skipIfUnavailable(ctx);
 *     await pg.db.selectFrom(...)
 *   });
 *
 * The migrations must have been applied (`pnpm --filter @udemy/db migrate:latest`).
 */
export const IT_DEFAULT_DATABASE_URL = 'postgres://udemy:udemy@localhost:55432/udemy';
export const IT_DEFAULT_REDIS_URL = 'redis://localhost:56379';

export function itDatabaseUrl(): string {
  return nonEmpty(process.env.IT_DATABASE_URL) ?? IT_DEFAULT_DATABASE_URL;
}

export function itRedisUrl(): string {
  return nonEmpty(process.env.IT_REDIS_URL) ?? IT_DEFAULT_REDIS_URL;
}

/** GitLab (and most CI systems) export `CI=true`. */
export function isCi(): boolean {
  return process.env.CI === 'true';
}

/**
 * Deadline for connecting + the first round trip. Below the 30 s hookTimeout (vitest.config.mts),
 * so this message, not a bare "Hook timed out", reports a stalled dependency. Generous because
 * under a full parallel `turbo run lint typecheck test build` connection setup through Docker
 * Desktop's port forwarding was measured at up to ~25 s.
 */
export const PROBE_TIMEOUT_MS = 25_000;
/** Teardown must never hang a run: a client stuck mid-connect is abandoned after this. */
const TEARDOWN_TIMEOUT_MS = 5_000;

class ProbeTimeout extends Error {}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Awaits `promise` for at most `ms`; on timeout gives up (with a note) instead of hanging. */
async function settleWithin(promise: Promise<unknown>, ms: number, what: string): Promise<void> {
  try {
    await withDeadline(promise, ms, `${what} did not finish within ${ms} ms`);
  } catch (error) {
    process.stderr.write(`[integration] ${describeError(error)}; abandoning it.\n`);
  }
}

/** `udemy-api-it:<spec file>`: lets pg_stat_activity / pg_locks attribute a backend to a file. */
function applicationName(): string {
  const testPath = expect.getState().testPath;
  return testPath === undefined ? 'udemy-api-it' : `udemy-api-it:${basename(testPath)}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Hides the password of a connection URL in messages. */
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
  if (error instanceof AggregateError && error.errors.length > 0) {
    return describeError(error.errors[0]);
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** The vitest test context's `skip` (typed structurally to stay version-agnostic). */
export interface SkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface IntegrationResource<T> {
  /** The connected client; throws when the dependency is unavailable. */
  readonly client: T;
  readonly available: boolean;
  /** Why the dependency is unavailable (undefined when available). */
  readonly unavailableReason: string | undefined;
  /** Call first in every test: skips it locally when the dependency is unavailable. */
  skipIfUnavailable(ctx: SkippableContext): void;
}

const reported = new Set<string>();

function unavailable(name: string, envVar: string, url: string, error: unknown): string {
  if (error instanceof ProbeTimeout) {
    throw new Error(
      `[integration] ${name} at ${redact(url)} accepted the connection but did not answer within ` +
        `${PROBE_TIMEOUT_MS} ms. It is running, so this is not skipped: the host or the Docker VM ` +
        `is overloaded (check \`docker stats\`, VM memory/swap), or a lock is held (pg_locks).`,
      { cause: error },
    );
  }
  const reason =
    `${name} at ${redact(url)} is unreachable (${describeError(error)}). ` +
    `Start infra/docker/docker-compose.dev.yml (and run the migrations) or set ${envVar}.`;
  if (isCi()) {
    throw new Error(
      `[integration] ${reason} CI=true: integration tests must not be skipped in CI.`,
      { cause: error },
    );
  }
  if (!reported.has(reason)) {
    reported.add(reason);
    process.stderr.write(`[integration] ${reason} Skipping its integration tests.\n`);
  }
  return reason;
}

function resource<T>(
  name: string,
  get: () => T | undefined,
  reason: () => string | undefined,
): IntegrationResource<T> {
  return {
    get client(): T {
      const value = get();
      if (value === undefined || reason() !== undefined) {
        throw new Error(`[integration] ${name} is not available: ${reason() ?? 'not connected'}`);
      }
      return value;
    },
    get available(): boolean {
      return get() !== undefined && reason() === undefined;
    },
    get unavailableReason(): string | undefined {
      return reason();
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      const why = reason();
      ctx.skip(why !== undefined, why);
    },
  };
}

export interface IntegrationDatabase extends IntegrationResource<Kysely<DB>> {
  /** Alias of `client`. */
  readonly db: Kysely<DB>;
}

/**
 * Registers beforeAll/afterAll hooks that connect to IT_DATABASE_URL and close the pool.
 * Probes a Phase 1 table, so an unmigrated database counts as unavailable too.
 */
export function useIntegrationDatabase(options: { max?: number } = {}): IntegrationDatabase {
  const url = itDatabaseUrl();
  let db: Kysely<DB> | undefined;
  let reason: string | undefined = 'not connected yet (used outside a test?)';

  beforeAll(async () => {
    db = createDatabase({
      connectionString: url,
      max: options.max ?? 4,
      applicationName: applicationName(),
    });
    try {
      await withDeadline(
        sql`select 1 from identity.users limit 0`.execute(db),
        PROBE_TIMEOUT_MS,
        'Postgres probe timed out',
      );
      reason = undefined;
    } catch (error) {
      reason = unavailable('Postgres', 'IT_DATABASE_URL', url, error);
    }
  });

  afterAll(async () => {
    // pg's Pool.end() waits for a client that is still connecting (no connect timeout is set).
    if (db !== undefined) await settleWithin(db.destroy(), TEARDOWN_TIMEOUT_MS, 'Closing the pool');
  });

  const base = resource(
    'Postgres',
    () => db,
    () => reason,
  );
  return Object.defineProperties(base, {
    db: { get: () => base.client, enumerable: true },
  }) as IntegrationDatabase;
}

export interface IntegrationRedis extends IntegrationResource<Redis> {
  /** Alias of `client`. */
  readonly redis: Redis;
}

/** Registers beforeAll/afterAll hooks that connect to IT_REDIS_URL and quit afterwards. */
export function useIntegrationRedis(): IntegrationRedis {
  const url = itRedisUrl();
  let redis: Redis | undefined;
  let reason: string | undefined = 'not connected yet (used outside a test?)';

  beforeAll(async () => {
    // A stopped Redis refuses the connection at once (ECONNREFUSED -> skip locally), so a long
    // connect timeout costs nothing there. It used to be 1 s, which under load turned a slow but
    // healthy Redis into a silent local skip. `connectTimeout` covers only the TCP connect, which
    // Docker Desktop's port proxy accepts instantly; the deadline covers the ready check + PING.
    const client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: PROBE_TIMEOUT_MS,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis = client;
    client.on('error', () => undefined);
    try {
      await withDeadline(
        (async () => {
          await client.connect();
          if ((await client.ping()) !== 'PONG') throw new Error('PING did not answer PONG');
        })(),
        PROBE_TIMEOUT_MS,
        'Redis probe timed out',
      );
      reason = undefined;
    } catch (error) {
      reason = unavailable('Redis', 'IT_REDIS_URL', url, error);
    } finally {
      if (reason !== undefined) client.disconnect();
    }
  });

  afterAll(async () => {
    if (redis === undefined) return;
    if (reason !== undefined) return;
    const client = redis;
    await settleWithin(client.quit(), TEARDOWN_TIMEOUT_MS, 'Redis QUIT');
    client.disconnect();
  });

  const base = resource(
    'Redis',
    () => redis,
    () => reason,
  );
  return Object.defineProperties(base, {
    redis: { get: () => base.client, enumerable: true },
  }) as IntegrationRedis;
}

/**
 * Removes everything the tests wrote for these users, including the append-only
 * `identity.security_events` and `access.role_changes` rows. Needs a superuser (dev compose and
 * CI both connect as one): `session_replication_role = replica` disables the append-only
 * triggers and FK checks for this transaction only (schema doc §4 "Constraints on the setup").
 */
export async function deleteTestUsers(db: Kysely<DB>, userIds: readonly string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await trx.deleteFrom('identity.securityEvents').where('userId', 'in', ids).execute();
    await trx.deleteFrom('outbox.events').where('aggregateId', 'in', ids).execute();
    await trx.deleteFrom('access.roleChanges').where('userId', 'in', ids).execute();
    await trx.deleteFrom('access.userRoles').where('userId', 'in', ids).execute();
    await trx.deleteFrom('identity.userBans').where('userId', 'in', ids).execute();
    await trx.deleteFrom('identity.oneTimeTokens').where('userId', 'in', ids).execute();
    // Replica mode also disables ON DELETE CASCADE (it is trigger-based): tokens first.
    await trx
      .deleteFrom('identity.refreshTokens')
      .where('sessionId', 'in', (eb) =>
        eb.selectFrom('identity.sessions').select('id').where('userId', 'in', ids),
      )
      .execute();
    await trx.deleteFrom('identity.sessions').where('userId', 'in', ids).execute();
    await trx.deleteFrom('identity.users').where('id', 'in', ids).execute();
  });
}
