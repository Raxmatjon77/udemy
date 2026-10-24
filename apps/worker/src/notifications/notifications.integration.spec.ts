import type { EventEnvelope } from '@udemy/contracts';
import { type LeasedFanoutJob, reapExpiredFanoutLeases, sql } from '@udemy/db';
import {
  createActiveEnrollment,
  createQuestion,
  createUser,
  deleteTestData,
  skipUnlessMigrated,
  useIntegrationDb,
} from '@udemy/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecordingMailer } from '../identity/testing/identity-mail.fakes';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import { AdminRecipientsReader } from '../shared/mail/admin-recipients.reader';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import {
  cleanupPhase5,
  phase5Envelope,
  registered,
  seedAnnouncement,
  seedCourse,
} from '../testing/phase5-fixtures';
import { NotificationDeliverer } from './delivery/notification-deliverer';
import { NotificationPreferencesReader } from './delivery/notification-preferences.reader';
import { NotificationStore } from './delivery/notification.store';
import { FanoutRunner } from './fanout/fanout-runner';
import { AnnouncementFanoutEnqueuer } from './handlers/announcement-fanout-enqueuer.handler';
import {
  HiddenContentNotices,
  QuestionHiddenNotifier,
} from './handlers/moderation-notifier.handlers';
import { QaQuestionPostedNotifier } from './handlers/qa-notifier.handlers';
import { NotificationContextReader } from './persistence/notification-context.reader';
import { NotificationRetentionJob } from './retention/notification-retention.job';
import {
  notificationLinks,
  notificationsConfig,
  RecordingRealtime,
} from './testing/notifications.fakes';

/**
 * Notifiers, redaction, the announcement fan-out and retention against the dev Postgres, with
 * the real idempotent processor and SQL; mail and realtime are recording fakes. Consumer names
 * are `it.`-prefixed. Fan-out jobs are leased by hand (not `leaseFanoutJob`, which takes the
 * oldest due job of the shared database), so a running worker or leftovers never interfere.
 *
 * WRITTEN IN CODE-ONLY MODE (P5-T15): never run yet.
 */
describe('notifications (integration: Postgres)', () => {
  const pg = useIntegrationDb();
  const userIds: string[] = [];
  const categoryIds: string[] = [];
  const courseIds: string[] = [];
  const eventIds: string[] = [];
  let mailer: RecordingMailer;
  let realtime: RecordingRealtime;
  let deliverer: NotificationDeliverer;
  let reader: NotificationContextReader;
  let store: NotificationStore;
  let preferences: NotificationPreferencesReader;
  let processor: IdempotentEventProcessor;

  beforeAll(() => {
    if (pg.unavailableReason !== undefined) return;
    processor = new IdempotentEventProcessor(pg.db);
  });

  beforeEach(() => {
    mailer = new RecordingMailer();
    realtime = new RecordingRealtime();
    reader = new NotificationContextReader();
    store = new NotificationStore();
    preferences = new NotificationPreferencesReader();
    deliverer = new NotificationDeliverer(
      new UserContactReader(),
      preferences,
      store,
      mailer,
      notificationLinks(),
      realtime.asEmitter(),
    );
  });

  afterAll(async () => {
    if (pg.unavailableReason !== undefined) return;
    await cleanupPhase5(pg.db, { eventIds, courseIds });
    await deleteTestData(pg.db, userIds, categoryIds);
  });

  function track(envelope: EventEnvelope): EventEnvelope {
    eventIds.push(envelope.eventId);
    return envelope;
  }

  async function user(): Promise<string> {
    const id = await createUser(pg.db);
    userIds.push(id);
    return id;
  }

  async function course(ownerId: string): Promise<string> {
    const seeded = await seedCourse(pg.db, ownerId);
    categoryIds.push(...seeded.categoryIds);
    courseIds.push(seeded.courseId);
    return seeded.courseId;
  }

  async function rowsOf(userId: string) {
    return pg.db
      .selectFrom('notifications.notifications')
      .select([
        'id',
        'kind',
        'app',
        'subjectType',
        'subjectId',
        'payload',
        'redactedAt',
        'sourceEventId',
      ])
      .where('userId', '=', userId)
      .orderBy('id')
      .execute();
  }

  function qaNotifier(): RegisteredEventHandler {
    return registered(
      'engagement.question',
      'QuestionPosted',
      'notifications.qa-notifier.question-posted',
      new QaQuestionPostedNotifier(reader, deliverer),
    );
  }

  const questionPosted = (questionId: string, courseId: string, authorId: string) =>
    track(
      phase5Envelope('QuestionPosted', 'engagement.question', courseId, {
        questionId,
        courseId,
        lectureId: null,
        authorId,
        postedAt: new Date().toISOString(),
      }),
    );

  it('QuestionPosted: one row, one push, one mail; a redelivery changes nothing', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const owner = await user();
    const student = await user();
    const courseId = await course(owner);
    const questionId = await createQuestion(pg.db, {
      authorId: student,
      courseId,
      title: 'IT question?',
    });
    const event = questionPosted(questionId, courseId, student);
    const handler = qaNotifier();

    await expect(processor.process(handler, event)).resolves.toBe('processed');
    await expect(processor.process(handler, event)).resolves.toBe('duplicate');
    // A replay that slips past the claim (another consumer name) still inserts nothing new.
    await expect(
      processor.process({ ...handler, consumerName: `${handler.consumerName}.replay` }, event),
    ).resolves.toBe('processed');

    const rows = await rowsOf(owner);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'QA_NEW_QUESTION',
        app: 'INSTRUCTOR',
        subjectType: 'QUESTION',
        subjectId: questionId,
        sourceEventId: event.eventId,
        redactedAt: null,
      }),
    ]);
    expect(realtime.emitted.filter((e) => e.event === 'notification.created')).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.headers?.['List-Unsubscribe']).toMatch(
      /^<http:\/\/localhost:3000\/api\/notifications\/unsubscribe\?token=v1\./,
    );
  }, 30_000);

  it('IN_APP off for the category: no row (but the e-mail still goes out)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const owner = await user();
    const student = await user();
    const courseId = await course(owner);
    await pg.db
      .insertInto('notifications.notificationPreferences')
      .values({ userId: owner, category: 'QA', channel: 'IN_APP', enabled: false })
      .execute();
    const questionId = await createQuestion(pg.db, { authorId: student, courseId });

    await processor.process(qaNotifier(), questionPosted(questionId, courseId, student));

    expect(await rowsOf(owner)).toEqual([]);
    expect(mailer.sent).toHaveLength(1);
  }, 30_000);

  it('QuestionHidden (AUTO): redacts once, tells the author and the admins', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const owner = await user();
    const student = await user();
    const admin = await user();
    await pg.db
      .insertInto('access.userRoles')
      .values({ userId: admin, roleCode: 'ADMIN' })
      .execute();
    const courseId = await course(owner);
    const questionId = await createQuestion(pg.db, {
      authorId: student,
      courseId,
      title: 'Secret title',
    });
    await processor.process(qaNotifier(), questionPosted(questionId, courseId, student));

    const hidden = track(
      phase5Envelope('QuestionHidden', 'engagement.question', courseId, {
        questionId,
        courseId,
        actorId: null,
        hiddenAt: new Date().toISOString(),
      }),
    );
    const handler = registered(
      'engagement.question',
      'QuestionHidden',
      'notifications.moderation-notifier.question-hidden',
      new QuestionHiddenNotifier(
        store,
        reader,
        new HiddenContentNotices(reader, new AdminRecipientsReader(), deliverer),
      ),
    );
    await expect(processor.process(handler, hidden)).resolves.toBe('processed');
    await expect(processor.process(handler, hidden)).resolves.toBe('duplicate');

    const [ownerRow] = await rowsOf(owner);
    expect(ownerRow?.redactedAt).not.toBeNull();
    expect(ownerRow?.payload).toMatchObject({ questionTitle: null, redacted: true });
    expect((await rowsOf(student)).map((r) => [r.kind, r.app, r.subjectType])).toEqual([
      ['CONTENT_HIDDEN', 'STUDENT', null],
    ]);
    expect((await rowsOf(admin)).map((r) => [r.kind, r.app])).toEqual([
      ['MODERATION_QUEUE', 'ADMIN'],
    ]);
  }, 30_000);

  describe('announcement fan-out', () => {
    async function setup(sendEmail: boolean) {
      const owner = await user();
      const students = [await user(), await user(), await user()];
      const courseId = await course(owner);
      await pg.db.transaction().execute(async (trx) => {
        for (const s of students) await createActiveEnrollment(trx, { userId: s, courseId });
      });
      const announcementId = await seedAnnouncement(pg.db, {
        courseId,
        authorId: owner,
        sendEmail,
      });
      const posted = track(
        phase5Envelope('AnnouncementPosted', 'engagement.announcement', courseId, {
          announcementId,
          courseId,
          authorId: owner,
          sendEmail,
          postedAt: new Date().toISOString(),
        }),
      );
      const enqueuer = registered(
        'engagement.announcement',
        'AnnouncementPosted',
        'notifications.announcement-fanout-enqueuer',
        new AnnouncementFanoutEnqueuer(),
      );
      await expect(processor.process(enqueuer, posted)).resolves.toBe('processed');
      await expect(processor.process(enqueuer, posted)).resolves.toBe('duplicate');
      const jobs = await pg.db
        .selectFrom('notifications.fanoutJobs')
        .select(['id', 'status'])
        .where('sourceEventId', '=', posted.eventId)
        .execute();
      expect(jobs).toHaveLength(1);
      return { owner, students, courseId, announcementId, posted, jobId: jobs[0]!.id };
    }

    /** Leases THIS job by hand (QUEUED -> RUNNING, attempts + 1), like leaseFanoutJob does. */
    async function leaseByHand(
      jobId: string,
      workerId: string,
      leaseExpired = false,
    ): Promise<LeasedFanoutJob> {
      const { rows } = await sql<{
        attempts: number;
        maxAttempts: number;
        courseId: string;
        subjectId: string;
        sendEmail: boolean;
        afterUserId: string | null;
        sourceEventId: string;
      }>`
        UPDATE notifications.fanout_jobs
           SET status = 'RUNNING', attempts = attempts + 1, lease_owner = ${workerId},
               lease_expires_at = now() + ${leaseExpired ? sql`interval '-1 minute'` : sql`interval '2 minutes'`}
         WHERE id = ${jobId} AND status = 'QUEUED'
        RETURNING attempts, max_attempts, course_id, subject_id, send_email, after_user_id, source_event_id
      `.execute(pg.db);
      const r = rows[0]!;
      return {
        jobId,
        workerId,
        attempt: r.attempts,
        kind: 'ANNOUNCEMENT',
        courseId: r.courseId,
        announcementId: r.subjectId,
        sendEmail: r.sendEmail,
        sourceEventId: r.sourceEventId,
        afterUserId: r.afterUserId,
        maxAttempts: r.maxAttempts,
      };
    }

    function runner(): FanoutRunner {
      return new FanoutRunner(pg.db, reader, preferences, store, deliverer);
    }

    it('one row per enrollee (not the author), pushes and e-mails per preference', async (ctx) => {
      pg.skipIfUnavailable(ctx);
      await skipUnlessMigrated(pg, ctx);
      const { owner, students, jobId } = await setup(true);
      const [mailOff, inAppOff, plain] = students as [string, string, string];
      await pg.db
        .insertInto('notifications.notificationPreferences')
        .values([
          { userId: mailOff, category: 'ANNOUNCEMENTS', channel: 'EMAIL', enabled: false },
          { userId: inAppOff, category: 'ANNOUNCEMENTS', channel: 'IN_APP', enabled: false },
        ])
        .execute();

      await expect(runner().run(await leaseByHand(jobId, 'it-worker'))).resolves.toBe('DONE');

      expect(await rowsOf(owner)).toEqual([]);
      expect((await rowsOf(mailOff)).map((r) => r.kind)).toEqual(['ANNOUNCEMENT']);
      expect(await rowsOf(inAppOff)).toEqual([]);
      expect((await rowsOf(plain)).map((r) => r.kind)).toEqual(['ANNOUNCEMENT']);
      expect(realtime.emitted.filter((e) => e.event === 'notification.created')).toHaveLength(2);
      const recipients = mailer.sent.map((m) => m.to).sort();
      expect(recipients).toHaveLength(2); // inAppOff and plain
      expect(
        mailer.sent.every(
          (m) => m.headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click',
        ),
      ).toBe(true);
      const job = await pg.db
        .selectFrom('notifications.fanoutJobs')
        .select(['status', 'processedCount'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow();
      expect(job).toEqual({ status: 'DONE', processedCount: 3 });
    }, 30_000);

    it('a lease lost mid-way writes nothing; the next lease resumes without duplicates', async (ctx) => {
      pg.skipIfUnavailable(ctx);
      await skipUnlessMigrated(pg, ctx);
      const { students, jobId } = await setup(false);
      const stale = await leaseByHand(jobId, 'it-worker-a', true);
      await reapExpiredFanoutLeases(pg.db); // RUNNING (expired) -> QUEUED with backoff
      await sql`UPDATE notifications.fanout_jobs SET run_after = now() WHERE id = ${jobId}`.execute(
        pg.db,
      );
      const fresh = await leaseByHand(jobId, 'it-worker-b');

      await expect(runner().run(stale)).resolves.toBe('LEASE_LOST');
      for (const s of students) expect(await rowsOf(s)).toEqual([]);

      await expect(runner().run(fresh)).resolves.toBe('DONE');
      await expect(runner().run(fresh)).resolves.toBe('LEASE_LOST'); // DONE: the fence fails
      for (const s of students)
        expect((await rowsOf(s)).map((r) => r.kind)).toEqual(['ANNOUNCEMENT']);
      expect(mailer.sent).toHaveLength(0); // send_email = false
    }, 30_000);

    it('a deleted announcement stops the fan-out with nothing sent', async (ctx) => {
      pg.skipIfUnavailable(ctx);
      await skipUnlessMigrated(pg, ctx);
      const { owner, students, announcementId, jobId } = await setup(true);
      await sql`
        UPDATE engagement.announcements SET deleted_at = now(), deleted_by = ${owner} WHERE id = ${announcementId}
      `.execute(pg.db);

      await expect(runner().run(await leaseByHand(jobId, 'it-worker'))).resolves.toBe('DONE');
      for (const s of students) expect(await rowsOf(s)).toEqual([]);
      expect(mailer.sent).toHaveLength(0);
    }, 30_000);
  });

  it('NotificationRetentionJob deletes rows older than 180 days only', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    const owner = await user();
    const old = await sql<{ id: string }>`
      INSERT INTO notifications.notifications (user_id, app, kind, payload, subject_type, subject_id, source_event_id, created_at)
      VALUES (${owner}, 'INSTRUCTOR', 'MEDIA_READY', '{"assetId":"01900000-0000-7000-8000-000000000001","purpose":"LECTURE_VIDEO","filename":null}',
              'MEDIA_ASSET', '01900000-0000-7000-8000-000000000001', gen_random_uuid(), now() - interval '181 days')
      RETURNING id
    `.execute(pg.db);
    const fresh = await sql<{ id: string }>`
      INSERT INTO notifications.notifications (user_id, app, kind, payload, subject_type, subject_id, source_event_id)
      VALUES (${owner}, 'INSTRUCTOR', 'MEDIA_READY', '{"assetId":"01900000-0000-7000-8000-000000000001","purpose":"LECTURE_VIDEO","filename":null}',
              'MEDIA_ASSET', '01900000-0000-7000-8000-000000000001', gen_random_uuid())
      RETURNING id
    `.execute(pg.db);
    const job = new NotificationRetentionJob(pg.db, notificationsConfig(), {} as never);

    const result = await job.runOnce();

    if (result.status === 'locked') return; // another process holds _07 right now
    expect(result.notificationsDeleted).toBeGreaterThanOrEqual(1);
    const left = (await rowsOf(owner)).map((r) => r.id);
    expect(left).toEqual([fresh.rows[0]!.id]);
    expect(left).not.toContain(old.rows[0]!.id);
  }, 60_000);
});
