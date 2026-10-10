import { createDatabase, type DB, type Kysely, sql } from '@udemy/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll } from 'vitest';

/**
 * The ONE convention for api integration tests (real Postgres / Redis):
 *
 * - `IT_DATABASE_URL` / `IT_REDIS_URL`, defaulting to the dev compose stack
 *   (infra/docker/docker-compose.dev.yml: Postgres on 55432, Redis on 56379).
 * - Locally, an unreachable dependency SKIPS the tests with a clear message.
 * - With `CI=true` (set by GitLab CI), an unreachable dependency FAILS the suite: CI must never
 *   go green by silently skipping its integration tests.
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
      applicationName: 'udemy-api-it',
    });
    try {
      await sql`select 1 from identity.users limit 0`.execute(db);
      reason = undefined;
    } catch (error) {
      reason = unavailable('Postgres', 'IT_DATABASE_URL', url, error);
    }
  });

  afterAll(async () => {
    await db?.destroy();
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
    redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      if ((await redis.ping()) !== 'PONG') throw new Error('PING did not answer PONG');
      reason = undefined;
    } catch (error) {
      reason = unavailable('Redis', 'IT_REDIS_URL', url, error);
    }
  });

  afterAll(async () => {
    if (redis === undefined) return;
    if (reason === undefined) await redis.quit();
    else redis.disconnect();
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
