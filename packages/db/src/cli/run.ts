import type { Kysely } from 'kysely';
import { createDatabase } from '../database';
import type { DB } from '../generated/db';

/** Shared CLI harness: reads DATABASE_URL, always closes the pool, sets exit code. */
export async function runCli(fn: (db: Kysely<DB>) => Promise<void>): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set (env or root .env)');
    process.exit(1);
  }
  const db = createDatabase({ connectionString, max: 1, applicationName: 'udemy-migrate' });
  try {
    await fn(db);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
