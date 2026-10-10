import { type DB, type Kysely, sql } from '@udemy/db';
import { deleteTestUsers } from '../../../testing/integration';

/**
 * Removes everything the users tests wrote for these users (profiles, applications, their
 * append-only transitions and their outbox events), then the users themselves through the
 * shared `deleteTestUsers`. Needs a superuser, like `deleteTestUsers`: replica mode disables the
 * append-only triggers and the deferred status/log triggers for this transaction only.
 */
export async function deleteUsersTestData(
  db: Kysely<DB>,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    const applications = await trx
      .selectFrom('users.instructorApplications')
      .select('id')
      .where('applicantId', 'in', ids)
      .execute();
    const applicationIds = applications.map((a) => a.id);
    if (applicationIds.length > 0) {
      await trx.deleteFrom('outbox.events').where('aggregateId', 'in', applicationIds).execute();
      await trx
        .deleteFrom('users.instructorApplicationTransitions')
        .where('applicationId', 'in', applicationIds)
        .execute();
      await trx
        .deleteFrom('users.instructorApplications')
        .where('id', 'in', applicationIds)
        .execute();
    }
    await trx.deleteFrom('users.profiles').where('userId', 'in', ids).execute();
  });
  await deleteTestUsers(db, ids);
}
