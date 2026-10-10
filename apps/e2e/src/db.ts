import pg from 'pg';

import { infra } from './env';

/**
 * Direct Postgres access, for cleanup only (the journeys themselves go through the browser).
 *
 * `deleteE2eUsers` mirrors `deleteTestUsers` + `deleteUsersTestData` of apps/api
 * (src/testing/integration.ts, src/modules/users/testing/users-test-data.ts). Those cannot be
 * imported here without pulling in vitest and the api's Kysely setup, so the same statements
 * are repeated as plain SQL. `session_replication_role = replica` (superuser, dev stack only)
 * switches off the append-only triggers and the trigger-based FKs/cascades for this
 * transaction only, which is why children are deleted before parents.
 *
 * Phase 2: a user's courses (with their revisions, curriculum and history) and media assets
 * (with jobs, renditions and usages) go with the user, like `deleteCatalogTestData` of apps/api
 * (src/modules/catalog/testing/catalog-it.ts). Their MinIO objects are removed by
 * `src/cleanup.ts`, which gets the asset ids from here.
 */

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: infra.databaseUrl, max: 2 });
}

export async function userIdsByEmail(pool: pg.Pool, emails: readonly string[]): Promise<string[]> {
  if (emails.length === 0) return [];
  const { rows } = await pool.query<{ id: string }>(
    'select id from identity.users where lower(email) = any($1::text[])',
    [emails.map((e) => e.toLowerCase())],
  );
  return rows.map((r) => r.id);
}

/** Ids of every user whose email looks e2e-generated (`e2e-…@example.test`). */
export async function e2eUserIds(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    String.raw`select id from identity.users where email like 'e2e-%@example.test'`,
  );
  return rows.map((r) => r.id);
}

/** The media assets the deleted users owned, for the object-storage cleanup. */
export interface DeletedAsset {
  id: string;
  ownerId: string;
}

export async function deleteUsers(
  pool: pg.Pool,
  userIds: readonly string[],
): Promise<DeletedAsset[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const assets = await deleteCatalogAndMedia(client, ids);
    // users module: applications, their append-only transitions and their outbox events.
    const { rows } = await client.query<{ id: string }>(
      'select id from users.instructor_applications where applicant_id = any($1::uuid[])',
      [ids],
    );
    const applicationIds = rows.map((r) => r.id);
    if (applicationIds.length > 0) {
      await client.query('delete from outbox.events where aggregate_id = any($1::text[])', [
        applicationIds,
      ]);
      await client.query(
        'delete from users.instructor_application_transitions where application_id = any($1::uuid[])',
        [applicationIds],
      );
      await client.query('delete from users.instructor_applications where id = any($1::uuid[])', [
        applicationIds,
      ]);
    }
    await client.query('delete from users.profiles where user_id = any($1::uuid[])', [ids]);
    // identity + access (deleteTestUsers).
    await client.query('delete from identity.security_events where user_id = any($1::uuid[])', [
      ids,
    ]);
    await client.query('delete from outbox.events where aggregate_id = any($1::text[])', [ids]);
    await client.query('delete from access.role_changes where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from access.user_roles where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from identity.user_bans where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from identity.one_time_tokens where user_id = any($1::uuid[])', [
      ids,
    ]);
    await client.query(
      `delete from identity.refresh_tokens
        where session_id in (select id from identity.sessions where user_id = any($1::uuid[]))`,
      [ids],
    );
    await client.query('delete from identity.sessions where user_id = any($1::uuid[])', [ids]);
    await client.query('delete from identity.users where id = any($1::uuid[])', [ids]);
    await client.query('commit');
    return assets;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Courses and media assets owned by `ownerIds` (inside deleteUsers' replica-mode transaction). */
async function deleteCatalogAndMedia(
  client: pg.PoolClient,
  ownerIds: readonly string[],
): Promise<DeletedAsset[]> {
  const ids = async (query: string, param: readonly string[]) =>
    (await client.query<{ id: string }>(query, [param])).rows.map((r) => r.id);
  const courseIds = await ids(
    'select id from catalog.courses where owner_id = any($1::uuid[])',
    ownerIds,
  );
  const revisionIds = await ids(
    'select id from catalog.course_revisions where course_id = any($1::uuid[])',
    courseIds,
  );
  const assets = (
    await client.query<{ id: string; owner_id: string }>(
      'select id, owner_id from media.assets where owner_id = any($1::uuid[])',
      [ownerIds],
    )
  ).rows.map((r) => ({ id: r.id, ownerId: r.owner_id }));
  const assetIds = assets.map((a) => a.id);

  // catalog.course (aggregate = course) and media.asset (aggregate = asset) outbox events.
  await client.query('delete from outbox.events where aggregate_id = any($1::text[])', [
    [...courseIds, ...revisionIds, ...assetIds],
  ]);
  const byCourse = (table: string) =>
    client.query(`delete from ${table} where course_id = any($1::uuid[])`, [courseIds]);
  const byRevision = (table: string) =>
    client.query(`delete from ${table} where revision_id = any($1::uuid[])`, [revisionIds]);
  await byCourse('catalog.course_transitions');
  await byRevision('catalog.revision_lectures');
  await byRevision('catalog.revision_sections');
  await byRevision('catalog.revision_bullets');
  await byCourse('catalog.course_revisions');
  await client.query(
    `delete from catalog.lecture_articles
      where lecture_id in (select id from catalog.lectures where course_id = any($1::uuid[]))`,
    [courseIds],
  );
  await byCourse('catalog.lectures');
  await byCourse('catalog.sections');
  await byCourse('catalog.course_bullets');
  await client.query('delete from catalog.courses where id = any($1::uuid[])', [courseIds]);

  for (const table of [
    'media.transcode_attempts',
    'media.transcode_jobs',
    'media.asset_renditions',
    'media.asset_usages',
  ]) {
    await client.query(`delete from ${table} where asset_id = any($1::uuid[])`, [assetIds]);
  }
  await client.query('delete from media.assets where id = any($1::uuid[])', [assetIds]);
  return assets;
}

/** Slug prefix of the categories the journeys create, so cleanup only touches those. */
export const E2E_CATEGORY_SLUG_PREFIX = 'e2e-';

/**
 * Deletes the e2e categories (subcategories first). Run after the e2e users: their courses are
 * the only ones filed under e2e categories.
 */
export async function deleteE2eCategories(pool: pg.Pool): Promise<void> {
  const pattern = `${E2E_CATEGORY_SLUG_PREFIX}%`;
  await pool.query('delete from catalog.categories where depth = 2 and slug like $1', [pattern]);
  await pool.query('delete from catalog.categories where depth = 1 and slug like $1', [pattern]);
}
