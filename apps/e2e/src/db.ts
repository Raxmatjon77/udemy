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

export async function deleteUsers(pool: pg.Pool, userIds: readonly string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
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
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
