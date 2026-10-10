import { deleteUsersAndMedia } from './cleanup';
import { createPool, deleteE2eCategories, e2eUserIds } from './db';
import { Mailpit } from './mailpit';
import { removeMediaFixtures } from './media-fixtures';

/**
 * Runs once after the journeys: deletes the e2e admin and any e2e user a failed test left
 * behind (with their courses, media rows and MinIO objects), the e2e categories, every e2e mail
 * and the generated media fixtures. Only `e2e-…` data is touched.
 */
export default async function globalTeardown(): Promise<void> {
  const pool = createPool();
  try {
    await deleteUsersAndMedia(pool, await e2eUserIds(pool));
    await deleteE2eCategories(pool);
  } finally {
    await pool.end();
  }
  await new Mailpit().deleteE2eMail();
  removeMediaFixtures();
}
