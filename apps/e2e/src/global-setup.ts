import { createPool, deleteUsers, e2eUserIds } from './db';
import { Mailpit } from './mailpit';
import { assertStackReachable, bootstrapE2eAdmin } from './stack';

/**
 * Runs once before the journeys (after the webServers are up):
 * 1. the docker stack answers (Postgres + migrations, Redis, Kafka, Debezium, Mailpit);
 * 2. leftovers of an aborted earlier run are removed (e2e users and e2e mail only);
 * 3. a fresh e2e ADMIN is bootstrapped with a random password.
 *
 * The admin credentials are handed to the test workers through `process.env` (workers inherit
 * it), so the password only ever lives in memory.
 */
export default async function globalSetup(): Promise<void> {
  await assertStackReachable();

  const pool = createPool();
  try {
    await deleteUsers(pool, await e2eUserIds(pool));
  } finally {
    await pool.end();
  }
  await new Mailpit().deleteE2eMail();

  const admin = await bootstrapE2eAdmin();
  process.env.E2E_ADMIN_USER_ID = admin.userId;
  process.env.E2E_ADMIN_EMAIL = admin.email;
  process.env.E2E_ADMIN_PASSWORD = admin.password;
  process.env.E2E_ADMIN_DISPLAY_NAME = admin.displayName;
}
