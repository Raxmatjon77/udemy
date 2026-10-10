import { createPool, deleteUsers, e2eUserIds } from './db';
import { Mailpit } from './mailpit';

/**
 * Runs once after the journeys: deletes the e2e admin and any e2e user a failed test left
 * behind, and every e2e mail. Only `e2e-…@example.test` data is touched.
 */
export default async function globalTeardown(): Promise<void> {
  const pool = createPool();
  try {
    await deleteUsers(pool, await e2eUserIds(pool));
  } finally {
    await pool.end();
  }
  await new Mailpit().deleteE2eMail();
}
