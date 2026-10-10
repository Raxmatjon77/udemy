import { randomUUID } from 'node:crypto';
import { createDatabase, type DB, type Kysely, sql } from '@udemy/db';
import { afterAll, beforeAll } from 'vitest';

/**
 * Worker integration tests against the dev compose stack, same convention as the api's
 * src/testing/integration.ts: IT_DATABASE_URL (default Postgres on 55432) and IT_MAILPIT_URL
 * (default http://localhost:8025, SMTP on IT_SMTP_PORT 1025). Locally an unreachable
 * dependency SKIPS the tests; with CI=true it FAILS them.
 */
export const IT_DEFAULT_DATABASE_URL = 'postgres://udemy:udemy@localhost:55432/udemy';
export const IT_DEFAULT_MAILPIT_URL = 'http://localhost:8025';

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

export const itDatabaseUrl = (): string => env('IT_DATABASE_URL', IT_DEFAULT_DATABASE_URL);
export const itMailpitUrl = (): string => env('IT_MAILPIT_URL', IT_DEFAULT_MAILPIT_URL);
export const itSmtpHost = (): string => env('IT_SMTP_HOST', 'localhost');
export const itSmtpPort = (): number => Number(env('IT_SMTP_PORT', '1025'));

export interface SkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface IntegrationStack {
  /** Throws when unavailable. */
  readonly db: Kysely<DB>;
  readonly unavailableReason: string | undefined;
  skipIfUnavailable(ctx: SkippableContext): void;
}

/** Connects to Postgres (migrated: probes identity.one_time_tokens) and pings Mailpit. */
export function useIntegrationStack(): IntegrationStack {
  let db: Kysely<DB> | undefined;
  let reason: string | undefined = 'not connected yet';

  beforeAll(async () => {
    db = createDatabase({
      connectionString: itDatabaseUrl(),
      max: 4,
      applicationName: 'udemy-worker-it',
    });
    try {
      await sql`select 1 from identity.one_time_tokens limit 0`.execute(db);
      const res = await fetch(`${itMailpitUrl()}/api/v1/info`);
      if (!res.ok) throw new Error(`Mailpit answered ${res.status}`);
      reason = undefined;
    } catch (error) {
      reason =
        `Postgres/Mailpit unreachable (${error instanceof Error ? error.message : String(error)}). ` +
        'Start infra/docker/docker-compose.dev.yml and run the migrations.';
      if (process.env.CI === 'true') throw new Error(`[integration] ${reason}`, { cause: error });
      process.stderr.write(`[integration] ${reason} Skipping.\n`);
    }
  });

  afterAll(async () => {
    await db?.destroy();
  });

  return {
    get db(): Kysely<DB> {
      if (db === undefined || reason !== undefined) throw new Error(`[integration] ${reason}`);
      return db;
    },
    get unavailableReason(): string | undefined {
      return reason;
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      ctx.skip(reason !== undefined, reason);
    },
  };
}

export interface MailpitMessage {
  readonly ID: string;
  readonly MessageID: string;
  readonly Subject: string;
  readonly Text: string;
  readonly HTML: string;
}

/** Polls Mailpit until `count` messages to `address` exist; returns them oldest first. */
export async function waitForMail(
  address: string,
  options: { count?: number; timeoutMs?: number } = {},
): Promise<MailpitMessage[]> {
  const count = options.count ?? 1;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const res = await fetch(
      `${itMailpitUrl()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const body = (await res.json()) as { messages: { ID: string }[] };
    if (body.messages.length >= count) {
      const messages = await Promise.all(
        body.messages.map(async (m) => {
          const detail = await fetch(`${itMailpitUrl()}/api/v1/message/${m.ID}`);
          return (await detail.json()) as MailpitMessage;
        }),
      );
      return messages.reverse();
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${count} mail(s) to ${address} (got ${body.messages.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Deletes the Mailpit messages to `address`. */
export async function deleteMail(address: string): Promise<void> {
  await fetch(`${itMailpitUrl()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`, {
    method: 'DELETE',
  });
}

/** The token from a `#token=…` fragment link in a mail body. */
export function tokenFromMail(text: string, path: '/verify-email' | '/reset-password'): string {
  const match = new RegExp(`${path}#token=([A-Za-z0-9_-]+)`).exec(text);
  if (match?.[1] === undefined) throw new Error(`No ${path} token link in the mail`);
  return match[1];
}

/** Deletes the Mailpit messages matching a search query (e.g. `subject:"..."`). */
export async function deleteMailMatching(query: string): Promise<void> {
  await fetch(`${itMailpitUrl()}/api/v1/search?query=${encodeURIComponent(query)}`, {
    method: 'DELETE',
  });
}

/** Mail to `address` must stay at exactly `count`: waits for them, then for stragglers. */
export async function exactlyMails(address: string, count: number): Promise<MailpitMessage[]> {
  if (count > 0) await waitForMail(address, { count });
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (count === 0) {
    const res = await fetch(
      `${itMailpitUrl()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const body = (await res.json()) as { messages: unknown[] };
    if (body.messages.length !== 0) {
      throw new Error(`Expected no mail to ${address}, got ${body.messages.length}`);
    }
    return [];
  }
  return waitForMail(address, { count });
}

/**
 * Deletes everything integration tests committed for these users: their media assets (with
 * jobs, attempts, renditions, usages), their courses with all catalog children and history,
 * outbox rows of those aggregates, role grants, then the users. `session_replication_role =
 * replica` disables the append-only triggers and FK checks for this transaction only; it needs a
 * superuser, which the dev compose stack and CI connect as (same approach as `@udemy/db` tests).
 */
export async function deleteTestData(
  db: Kysely<DB>,
  userIds: readonly string[],
  extraAggregateIds: readonly string[] = [],
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`
      DELETE FROM outbox.events
       WHERE aggregate_id IN (SELECT id::text FROM media.assets WHERE owner_id = ANY(${ids}::uuid[]))
          OR aggregate_id = ANY(${[...extraAggregateIds]}::text[])
    `.execute(trx);
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
    await trx.deleteFrom('access.userRoles').where('userId', 'in', ids).execute();
    await trx.deleteFrom('identity.users').where('id', 'in', ids).execute();
  });
}

/** Inserts a user for integration tests; returns its id and (unique) address. */
export async function insertTestUser(
  db: Kysely<DB>,
  options: { tag: string; displayName?: string; role?: 'ADMIN' | 'INSTRUCTOR' },
): Promise<{ id: string; email: string }> {
  const email = `it-worker-${options.tag}-${randomUUID()}@example.test`;
  const row = await db
    .insertInto('identity.users')
    .values({
      email,
      displayName: options.displayName ?? 'Worker IT',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$aW50ZWdyYXRpb24$aW50ZWdyYXRpb24',
      passwordChangedAt: sql<Date>`now()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (options.role !== undefined) {
    await db
      .insertInto('access.userRoles')
      .values({ userId: row.id, roleCode: options.role })
      .execute();
  }
  return { id: row.id, email };
}
