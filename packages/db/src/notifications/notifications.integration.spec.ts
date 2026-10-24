import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { listActiveEnrolleesAfter } from '../enrollment/enrollees';
import { createUser } from '../testing/fixtures';
import { createActiveEnrollment } from '../testing/phase5-fixtures';
import {
  deleteTestData,
  expectFailure,
  rollback,
  skipUnlessMigrated,
  useIntegrationDb,
} from '../testing/it-db.mjs';
import {
  advanceFanoutJob,
  enqueueAnnouncementFanout,
  type FanoutFence,
  insertAnnouncementNotifications,
  leaseFanoutJob,
  lockFanoutBatch,
  reapExpiredFanoutLeases,
} from './fanout';
import { deleteExpiredNotifications, deleteFinishedFanoutJobs } from './retention';

/**
 * notifications.* invariants and the leased fan-out (docs/phase-5-schema-design.md §2, §6 R10,
 * §8.6, §8.7). The fan-out tests commit (two workers = two connections); their users are removed
 * by deleteTestData and their jobs by source event id in afterAll. Lease expiry is simulated by
 * moving `lease_expires_at` into the past, never by waiting. Never run in P5-T4 (Docker stopped).
 */
const pg = useIntegrationDb({ max: 6 });
const committedUsers: string[] = [];
const committedEvents: string[] = [];

afterAll(async () => {
  if (pg.unavailableReason !== undefined) return;
  if (committedEvents.length > 0) {
    await sql`DELETE FROM notifications.fanout_jobs WHERE source_event_id = ANY(${committedEvents}::uuid[])`.execute(
      pg.db,
    );
  }
  await deleteTestData(pg.db, committedUsers);
});

const BATCH = 2;

/** A committed course with `n` ACTIVE enrollees and a QUEUED fan-out job that sorts first. */
async function fanoutWorld(n: number) {
  const course = randomUUID();
  const enrollees: string[] = [];
  for (let i = 0; i < n; i++) {
    const user = await createUser(pg.db);
    committedUsers.push(user);
    await pg.db
      .transaction()
      .execute((trx) => createActiveEnrollment(trx, { userId: user, courseId: course }));
    enrollees.push(user);
  }
  const sourceEventId = randomUUID();
  committedEvents.push(sourceEventId);
  const announcementId = randomUUID();
  expect(
    await enqueueAnnouncementFanout(pg.db, {
      sourceEventId,
      courseId: course,
      announcementId,
      sendEmail: true,
    }),
  ).toBe(true);
  expect(
    await enqueueAnnouncementFanout(pg.db, {
      sourceEventId,
      courseId: course,
      announcementId,
      sendEmail: true,
    }),
  ).toBe(false);
  // make it the oldest due job, so leaseFanoutJob picks this one even on a shared database
  await sql`UPDATE notifications.fanout_jobs SET run_after = '2000-01-01T00:00:00Z' WHERE source_event_id = ${sourceEventId}`.execute(
    pg.db,
  );
  return { course, enrollees: enrollees.sort(), sourceEventId, announcementId };
}

/** One batch transaction: fence, next enrollees, inserts, cursor advance. null = lease lost. */
async function runBatch(fence: FanoutFence, w: Awaited<ReturnType<typeof fanoutWorld>>) {
  return pg.db.transaction().execute(async (trx) => {
    const job = await lockFanoutBatch(trx, fence);
    if (job === null) return null;
    const users = await listActiveEnrolleesAfter(trx, w.course, job.afterUserId, BATCH);
    const inserted = await insertAnnouncementNotifications(trx, {
      sourceEventId: w.sourceEventId,
      announcementId: w.announcementId,
      userIds: users,
      payload: {
        announcementId: w.announcementId,
        courseId: w.course,
        title: 'Hello',
        redacted: false,
      },
    });
    const done = users.length < BATCH;
    expect(
      await advanceFanoutJob(trx, fence, {
        lastUserId: users.at(-1) ?? null,
        processed: users.length,
        done,
      }),
    ).toBe(true);
    return { users, inserted, done };
  });
}

async function jobOf(sourceEventId: string) {
  const { rows } = await sql<{
    id: string;
    status: string;
    attempts: number;
    processedCount: number;
    afterUserId: string | null;
    lastErrorCode: string | null;
  }>`
    SELECT id, status, attempts, processed_count, after_user_id, last_error_code
      FROM notifications.fanout_jobs WHERE source_event_id = ${sourceEventId}
  `.execute(pg.db);
  return rows[0]!;
}

describe('announcement fan-out lease (R10)', () => {
  it('a lease lost mid-run stops the old worker; the next lease resumes from the cursor; no duplicates', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const w = await fanoutWorld(5);
    const a = await leaseFanoutJob(pg.db, { workerId: 'it-worker-a', leaseMs: 60_000 });
    expect(a).toMatchObject({ announcementId: w.announcementId, attempt: 1, afterUserId: null });
    const first = await runBatch(a!, w);
    expect(first).toMatchObject({ users: w.enrollees.slice(0, 2), done: false });

    // the lease expires (simulated) and the reaper requeues the job
    await sql`UPDATE notifications.fanout_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${a!.jobId}`.execute(
      pg.db,
    );
    const reaped = await reapExpiredFanoutLeases(pg.db);
    expect(reaped).toContainEqual({ jobId: a!.jobId, status: 'QUEUED', attempts: 1 });
    expect(await jobOf(w.sourceEventId)).toMatchObject({
      status: 'QUEUED',
      lastErrorCode: 'lease_expired',
    });

    // the old worker's next batch finds its fence gone and writes nothing
    expect(await runBatch(a!, w)).toBeNull();

    await sql`UPDATE notifications.fanout_jobs SET run_after = '2000-01-01T00:00:00Z' WHERE id = ${a!.jobId}`.execute(
      pg.db,
    );
    const b = await leaseFanoutJob(pg.db, { workerId: 'it-worker-b', leaseMs: 60_000 });
    expect(b).toMatchObject({ jobId: a!.jobId, attempt: 2, afterUserId: w.enrollees[1] });
    // a replay of the old worker's batch (e.g. after a crash before COMMIT was seen) inserts nothing
    expect(
      await insertAnnouncementNotifications(pg.db, {
        sourceEventId: w.sourceEventId,
        announcementId: w.announcementId,
        userIds: w.enrollees.slice(0, 2),
        payload: { announcementId: w.announcementId, redacted: false },
      }),
    ).toEqual([]);
    const delivered = [...first!.inserted];
    for (let i = 0; i < 10; i++) {
      const r = await runBatch(b!, w);
      expect(r).not.toBeNull();
      delivered.push(...r!.inserted);
      if (r!.done) break;
    }
    expect([...delivered].sort()).toEqual(w.enrollees);
    const { rows } = await sql<{ n: number; distinct: number }>`
      SELECT count(*)::int AS n, count(DISTINCT user_id)::int AS distinct
        FROM notifications.notifications WHERE source_event_id = ${w.sourceEventId}`.execute(pg.db);
    expect(rows[0]).toEqual({ n: 5, distinct: 5 });
    expect(await jobOf(w.sourceEventId)).toMatchObject({ status: 'DONE', processedCount: 5 });
  });

  it('the reaper skips a job whose batch holds the row lock; the batch then renews the lease', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const w = await fanoutWorld(1);
    const a = await leaseFanoutJob(pg.db, { workerId: 'it-worker-a', leaseMs: 60_000 });
    expect(a?.announcementId).toBe(w.announcementId);
    await sql`UPDATE notifications.fanout_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${a!.jobId}`.execute(
      pg.db,
    );
    await pg.db.transaction().execute(async (trx) => {
      expect(await lockFanoutBatch(trx, a!)).not.toBeNull();
      // another connection: SKIP LOCKED passes over the locked job instead of requeueing it
      const reaped = await reapExpiredFanoutLeases(pg.db);
      expect(reaped.map((r) => r.jobId)).not.toContain(a!.jobId);
      expect(await advanceFanoutJob(trx, a!, { lastUserId: null, processed: 0, done: false })).toBe(
        true,
      );
    });
    expect(await reapExpiredFanoutLeases(pg.db)).not.toContainEqual(
      expect.objectContaining({ jobId: a!.jobId }),
    );
    expect(await jobOf(w.sourceEventId)).toMatchObject({ status: 'RUNNING', attempts: 1 });
    // finish it so afterAll leaves nothing RUNNING behind
    await pg.db.transaction().execute(async (trx) => {
      expect(await lockFanoutBatch(trx, a!)).not.toBeNull();
      await advanceFanoutJob(trx, a!, { lastUserId: null, processed: 0, done: true });
    });
  });

  it('job rows: created QUEUED, legal edges only, the cursor never moves back', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const created = await expectFailure(trx, () =>
        sql`
          INSERT INTO notifications.fanout_jobs (kind, source_event_id, course_id, subject_id, send_email, status, lease_owner, lease_expires_at)
          VALUES ('ANNOUNCEMENT', ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, false, 'RUNNING', 'w', now())`.execute(
          trx,
        ),
      );
      expect(created).toMatchObject({
        code: '23514',
        constraint: 'fanout_jobs_status_transition_ck',
      });
      const ev = randomUUID();
      await enqueueAnnouncementFanout(trx, {
        sourceEventId: ev,
        courseId: randomUUID(),
        announcementId: randomUUID(),
        sendEmail: false,
      });
      const id = sql`(SELECT id FROM notifications.fanout_jobs WHERE source_event_id = ${ev})`;
      await sql`
        UPDATE notifications.fanout_jobs SET status = 'RUNNING', attempts = 1, lease_owner = 'w', lease_expires_at = now() + interval '1 minute',
               after_user_id = 'ffffffff-ffff-7fff-bfff-ffffffffffff'
         WHERE id = ${id}`.execute(trx);
      for (const [label, statement, constraint] of [
        [
          'cursor back',
          sql`UPDATE notifications.fanout_jobs SET after_user_id = '00000000-0000-7000-8000-000000000000' WHERE id = ${id}`,
          'fanout_jobs_status_transition_ck',
        ],
        [
          'cursor reset',
          sql`UPDATE notifications.fanout_jobs SET after_user_id = NULL WHERE id = ${id}`,
          'fanout_jobs_status_transition_ck',
        ],
        [
          'count back',
          sql`UPDATE notifications.fanout_jobs SET processed_count = -1 WHERE id = ${id}`,
          'fanout_jobs_status_transition_ck',
        ],
        [
          'running without lease',
          sql`UPDATE notifications.fanout_jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ${id}`,
          'fanout_jobs_lease_ck',
        ],
        [
          'failed without code',
          sql`UPDATE notifications.fanout_jobs SET status = 'FAILED', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = ${id}`,
          'fanout_jobs_failed_ck',
        ],
      ] as const) {
        const err = await expectFailure(trx, () => statement.execute(trx));
        expect({ label, code: err.code, constraint: err.constraint }).toEqual({
          label,
          code: '23514',
          constraint,
        });
      }
      await sql`
        UPDATE notifications.fanout_jobs SET status = 'DONE', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ${id}`.execute(trx);
      const terminal = await expectFailure(trx, () =>
        sql`UPDATE notifications.fanout_jobs SET status = 'QUEUED', finished_at = NULL WHERE id = ${id}`.execute(
          trx,
        ),
      );
      expect(terminal).toMatchObject({
        code: '23514',
        constraint: 'fanout_jobs_status_transition_ck',
      });
    });
  });
});

describe('notification rows', () => {
  it('read once, redacted once (contracts redaction shape), kind/app/subject/payload CHECKs', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const subject = randomUUID();
      const insert = (kind: string, app: string, subjectType: string | null, payload: unknown) =>
        sql<{ id: string }>`
          INSERT INTO notifications.notifications (user_id, app, kind, payload, subject_type, subject_id, source_event_id)
          VALUES (${user}, ${app}, ${kind}, ${JSON.stringify(payload)}::jsonb, ${subjectType},
                  ${subjectType === null ? null : subject}, ${randomUUID()})
          RETURNING id`.execute(trx);
      const payload = {
        questionId: subject,
        questionTitle: 'Why?',
        excerpt: 'Because',
        redacted: false,
      };
      const { rows } = await insert('QA_NEW_ANSWER', 'INSTRUCTOR', 'ANSWER', payload);
      const id = rows[0]!.id;

      await sql`UPDATE notifications.notifications SET read_at = now() WHERE id = ${id} AND read_at IS NULL`.execute(
        trx,
      );
      const reread = await expectFailure(trx, () =>
        sql`UPDATE notifications.notifications SET read_at = now() + interval '1 s' WHERE id = ${id}`.execute(
          trx,
        ),
      );
      expect(reread).toMatchObject({ code: '23514', constraint: 'notifications_immutable_ck' });
      const edit = await expectFailure(trx, () =>
        sql`UPDATE notifications.notifications SET payload = payload || '{"excerpt":"edited"}' WHERE id = ${id}`.execute(
          trx,
        ),
      );
      expect(edit).toMatchObject({ code: '23514', constraint: 'notifications_immutable_ck' });
      const halfRedacted = await expectFailure(trx, () =>
        sql`UPDATE notifications.notifications SET redacted_at = now() WHERE id = ${id}`.execute(
          trx,
        ),
      );
      expect(halfRedacted).toMatchObject({
        code: '23514',
        constraint: 'notifications_redacted_ck',
      });

      const redacted = { ...payload, questionTitle: null, excerpt: null, redacted: true };
      await sql`
        UPDATE notifications.notifications SET payload = ${JSON.stringify(redacted)}::jsonb, redacted_at = now()
         WHERE id = ${id} AND redacted_at IS NULL`.execute(trx);
      const again = await expectFailure(trx, () =>
        sql`UPDATE notifications.notifications SET payload = '{"redacted": true}', redacted_at = now() WHERE id = ${id}`.execute(
          trx,
        ),
      );
      expect(again).toMatchObject({ code: '23514', constraint: 'notifications_immutable_ck' });

      for (const [label, run, constraint] of [
        [
          'kind/app',
          () => insert('ANNOUNCEMENT', 'INSTRUCTOR', 'ANNOUNCEMENT', { redacted: false }),
          'notifications_kind_app_ck',
        ],
        [
          'kind/subject',
          () => insert('REVIEW_NEW', 'INSTRUCTOR', 'QUESTION', { redacted: false }),
          'notifications_kind_subject_ck',
        ],
        [
          'no subject for CONTENT_HIDDEN',
          () => insert('CONTENT_HIDDEN', 'STUDENT', 'REVIEW', {}),
          'notifications_kind_subject_ck',
        ],
        [
          'payload not an object',
          () => insert('MODERATION_QUEUE', 'ADMIN', null, [1, 2]),
          'notifications_payload_ck',
        ],
        [
          'payload > 4 KB',
          () => insert('MODERATION_QUEUE', 'ADMIN', null, { x: 'y'.repeat(4100) }),
          'notifications_payload_ck',
        ],
        [
          'born redacted',
          () => insert('QA_RESOLVED', 'STUDENT', 'QUESTION', { redacted: true }),
          'notifications_redacted_ck',
        ],
      ] as const) {
        const err = await expectFailure(trx, run);
        expect({ label, code: err.code, constraint: err.constraint }).toEqual({
          label,
          code: '23514',
          constraint,
        });
      }
      await insert('CONTENT_HIDDEN', 'STUDENT', null, { subjectType: 'REVIEW' });
      await insert('MODERATION_QUEUE', 'ADMIN', null, { openReportCount: 3 });
    });
  });

  it('retention deletes old notifications and finished fan-out jobs in batches', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      for (let i = 0; i < 3; i++) {
        await sql`
          INSERT INTO notifications.notifications (user_id, app, kind, payload, source_event_id, created_at)
          VALUES (${user}, 'ADMIN', 'MODERATION_QUEUE', '{}', ${randomUUID()}, now() - interval '181 days')`.execute(
          trx,
        );
      }
      await sql`
        INSERT INTO notifications.notifications (user_id, app, kind, payload, source_event_id)
        VALUES (${user}, 'ADMIN', 'MODERATION_QUEUE', '{}', ${randomUUID()})`.execute(trx);
      expect(await deleteExpiredNotifications(trx, { batchSize: 2 })).toBe(2);
      for (
        let i = 0;
        i < 100 && (await deleteExpiredNotifications(trx, { batchSize: 2 })) > 0;
        i++
      );
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM notifications.notifications WHERE user_id = ${user}`.execute(
        trx,
      );
      expect(rows[0]!.n).toBe(1);

      const ev = randomUUID();
      await enqueueAnnouncementFanout(trx, {
        sourceEventId: ev,
        courseId: randomUUID(),
        announcementId: randomUUID(),
        sendEmail: false,
      });
      await sql`
        UPDATE notifications.fanout_jobs SET status = 'RUNNING', attempts = 1, lease_owner = 'w', lease_expires_at = now()
         WHERE source_event_id = ${ev}`.execute(trx);
      await sql`
        UPDATE notifications.fanout_jobs SET status = 'DONE', finished_at = now() - interval '31 days', lease_owner = NULL, lease_expires_at = NULL
         WHERE source_event_id = ${ev}`.execute(trx);
      for (
        let i = 0;
        i < 100 && (await deleteFinishedFanoutJobs(trx, { batchSize: 1000 })) > 0;
        i++
      );
      const jobs = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM notifications.fanout_jobs WHERE source_event_id = ${ev}`.execute(
        trx,
      );
      expect(jobs.rows[0]!.n).toBe(0);
    });
  });
});
