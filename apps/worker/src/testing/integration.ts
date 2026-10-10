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
