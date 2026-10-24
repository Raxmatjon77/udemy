import { type DB, type Kysely, sql } from '@udemy/db';
import type { Redis } from 'ioredis';

/**
 * Integration support for learning (IT conventions of `src/testing/integration.ts`): every file
 * owns its data. Redis keys of the progress buffer live under a per-file prefix
 * (`RedisProgressKeys(prefix)`), so no test touches the real `lp:dirty`.
 */

/** Deletes every key under `prefix` (SCAN, never KEYS / FLUSH*). */
export async function deleteRedisPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

/**
 * Removes everything learning tests wrote for these users: progress, activity, completions, the
 * (append-only) course completions and their `learning.progress` outbox events (aggregate id =
 * user id), and (P5-T11) notes, quiz attempts with their questions and selections, certificates
 * with their transitions and `learning.certificate` events (aggregate id = certificate id). Needs a superuser: replica mode disables the append-only guards for this
 * transaction. Run it BEFORE the users are deleted.
 */
export async function deleteLearningTestData(
  db: Kysely<DB>,
  userIds: readonly string[],
): Promise<void> {
  const users = [...new Set(userIds)];
  if (users.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    // P5-T11: certificates (their events are keyed by certificate id), notes, quiz attempts.
    const certificateIds = (
      await trx
        .selectFrom('learning.certificates')
        .select('id')
        .where('userId', 'in', users)
        .execute()
    ).map((r) => r.id);
    if (certificateIds.length > 0) {
      await trx.deleteFrom('outbox.events').where('aggregateId', 'in', certificateIds).execute();
      await trx
        .deleteFrom('learning.certificateTransitions')
        .where('certificateId', 'in', certificateIds)
        .execute();
      await trx.deleteFrom('learning.certificates').where('id', 'in', certificateIds).execute();
    }
    await trx.deleteFrom('learning.notes').where('userId', 'in', users).execute();
    const attemptIds = trx
      .selectFrom('learning.quizAttempts')
      .select('id')
      .where('userId', 'in', users);
    await trx
      .deleteFrom('learning.quizAttemptSelections')
      .where('attemptId', 'in', attemptIds)
      .execute();
    await trx
      .deleteFrom('learning.quizAttemptQuestions')
      .where('attemptId', 'in', attemptIds)
      .execute();
    await trx.deleteFrom('outbox.events').where('aggregateId', 'in', users).execute();
    await trx.deleteFrom('learning.lectureProgress').where('userId', 'in', users).execute();
    await trx.deleteFrom('learning.courseActivity').where('userId', 'in', users).execute();
    await trx.deleteFrom('learning.lectureCompletions').where('userId', 'in', users).execute();
    await trx.deleteFrom('learning.courseCompletions').where('userId', 'in', users).execute();
    await trx.deleteFrom('learning.quizAttempts').where('userId', 'in', users).execute();
  });
}

/** The `learning.progress` outbox event types of a user, oldest first. */
export async function learningEventTypes(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('outbox.events')
    .select('type')
    .where('aggregateId', '=', userId)
    .where('aggregateType', '=', 'learning.progress')
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
  return rows.map((r) => r.type);
}
