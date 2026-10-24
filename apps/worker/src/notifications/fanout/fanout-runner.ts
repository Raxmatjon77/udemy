import { Injectable, Logger } from '@nestjs/common';
import { type NotificationContent, NotificationContentSchema } from '@udemy/contracts';
import {
  advanceFanoutJob,
  type DB,
  failFanoutAttempt,
  FANOUT_BATCH_SIZE,
  type FanoutFence,
  insertAnnouncementNotifications,
  type LeasedFanoutJob,
  listActiveEnrolleesAfter,
  lockFanoutBatch,
  type Transaction,
  withTransaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { UserContact } from '../../shared/mail/user-contact.reader';
import { NotificationDeliverer } from '../delivery/notification-deliverer';
import { NotificationPreferencesReader } from '../delivery/notification-preferences.reader';
import { NotificationStore } from '../delivery/notification.store';
import { NotificationContextReader } from '../persistence/notification-context.reader';

/** The batch lost its lease (fence or advance updated 0 rows): roll back and stop. */
export class FanoutLeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`Fan-out job ${jobId} lost its lease`);
    this.name = 'FanoutLeaseLostError';
  }
}

export type FanoutJobOutcome = 'DONE' | 'LEASE_LOST' | 'FAILED' | 'STOPPED';

interface BatchMail {
  readonly userId: string;
  readonly contact: UserContact;
}

interface BatchResult {
  readonly done: boolean;
  /** Rows created by this batch: pushed after commit. */
  readonly created: readonly { userId: string; notificationId: string }[];
  /** E-mails to send after commit (send_email AND the user's EMAIL preference). */
  readonly mails: readonly BatchMail[];
  readonly content: NotificationContent | null;
}

const NOTHING: Omit<BatchResult, 'done'> = { created: [], mails: [], content: null };

/**
 * Runs one leased announcement fan-out job (design D18, schema doc §8.6, race R10), batch by
 * batch until DONE, the lease is lost, or shutdown:
 *
 * One batch = one transaction:
 *   1. `lockFanoutBatch` (fenced `FOR UPDATE` of the job row; null = lease lost, stop);
 *   2. the announcement `FOR SHARE` (a concurrent delete waits for this batch, so the
 *      moderation notifier's redaction sees its rows); deleted or gone -> DONE, nothing sent;
 *   3. <= 1000 ACTIVE enrollees after the cursor (`listActiveEnrolleesAfter`), minus the author;
 *   4. their ANNOUNCEMENTS preferences (one query); rows only for IN_APP = on,
 *      `insertAnnouncementNotifications` (`ON CONFLICT DO NOTHING RETURNING user_id`);
 *   5. `advanceFanoutJob` (cursor + lease renewal, or DONE when the batch was short); fenced,
 *      0 rows -> roll back.
 *
 * After COMMIT: `notification.created` pushes for the new rows, then e-mails (when the job's
 * `send_email` and the user's EMAIL preference allow) to the users that got a NEW row or have
 * IN_APP off. Both are best effort and at most once: the cursor already moved, so a crash here
 * loses them instead of duplicating them. A batch error (not a lost lease) ends the attempt with
 * `failFanoutAttempt` (QUEUED with backoff, FAILED after max_attempts).
 */
@Injectable()
export class FanoutRunner {
  private readonly logger = new Logger(FanoutRunner.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly reader: NotificationContextReader,
    private readonly preferences: NotificationPreferencesReader,
    private readonly store: NotificationStore,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async run(
    job: LeasedFanoutJob,
    shouldStop: () => boolean = () => false,
  ): Promise<FanoutJobOutcome> {
    const fence: FanoutFence = { jobId: job.jobId, workerId: job.workerId, attempt: job.attempt };
    let batches = 0;
    for (;;) {
      if (shouldStop()) return 'STOPPED';
      let result: BatchResult;
      try {
        result = await withTransaction(this.db, (trx) => this.batch(trx, job, fence));
      } catch (error) {
        if (error instanceof FanoutLeaseLostError) {
          this.logger.warn({ jobId: job.jobId, batches }, 'Fan-out lease lost; stopping');
          return 'LEASE_LOST';
        }
        const status = await failFanoutAttempt(this.db, fence, 'batch_failed').catch(() => null);
        this.logger.error(
          { err: error, jobId: job.jobId, attempt: job.attempt, status },
          'Fan-out batch failed',
        );
        return 'FAILED';
      }
      batches += 1;
      await this.afterCommit(job, result);
      if (result.done) {
        this.logger.log({ jobId: job.jobId, batches }, 'Fan-out job done');
        return 'DONE';
      }
    }
  }

  private async batch(
    trx: Transaction<DB>,
    job: LeasedFanoutJob,
    fence: FanoutFence,
  ): Promise<BatchResult> {
    const locked = await lockFanoutBatch(trx, fence);
    if (locked === null) throw new FanoutLeaseLostError(job.jobId);

    const finish = async (): Promise<BatchResult> => {
      const ok = await advanceFanoutJob(trx, fence, { lastUserId: null, processed: 0, done: true });
      if (!ok) throw new FanoutLeaseLostError(job.jobId);
      return { done: true, ...NOTHING };
    };

    const announcement = await this.reader.announcement(trx, job.announcementId, {
      forShare: true,
    });
    if (announcement === null || announcement.deleted) {
      this.logger.log({ jobId: job.jobId }, 'Announcement deleted; fan-out stops');
      return finish();
    }
    const course = await this.reader.course(trx, job.courseId);
    if (course === null) {
      this.logger.warn({ jobId: job.jobId, courseId: job.courseId }, 'Course gone; fan-out stops');
      return finish();
    }
    const content = NotificationContentSchema.parse({
      kind: 'ANNOUNCEMENT',
      payload: {
        announcementId: announcement.id,
        courseId: course.courseId,
        courseTitle: course.title,
        title: announcement.title,
        authorName: await this.reader.displayName(trx, announcement.authorId),
        redacted: false,
      },
    });

    const enrollees = await listActiveEnrolleesAfter(
      trx,
      job.courseId,
      locked.afterUserId,
      FANOUT_BATCH_SIZE,
    );
    const recipients = enrollees.filter((userId) => userId !== announcement.authorId);
    const prefs = await this.preferences.forUsers(trx, recipients, 'ANNOUNCEMENTS');
    const inAppUsers = recipients.filter((userId) => prefs.get(userId)?.inApp === true);
    const inserted = await insertAnnouncementNotifications(trx, {
      sourceEventId: job.sourceEventId,
      announcementId: announcement.id,
      userIds: inAppUsers,
      payload: content.payload,
    });
    const ids = await this.store.idsFor(trx, inserted, 'ANNOUNCEMENT', job.sourceEventId);
    const insertedSet = new Set(inserted);
    const mailUsers = job.sendEmail
      ? recipients.filter((userId) => {
          const p = prefs.get(userId);
          return p?.email === true && (insertedSet.has(userId) || !p.inApp);
        })
      : [];
    const contacts = await this.contacts(trx, mailUsers);

    const done = enrollees.length < FANOUT_BATCH_SIZE;
    const ok = await advanceFanoutJob(trx, fence, {
      lastUserId: enrollees.at(-1) ?? null,
      processed: enrollees.length,
      done,
    });
    if (!ok) throw new FanoutLeaseLostError(job.jobId);
    return {
      done,
      content,
      created: inserted.flatMap((userId) => {
        const notificationId = ids.get(userId);
        return notificationId === undefined ? [] : [{ userId, notificationId }];
      }),
      mails: mailUsers.flatMap((userId) => {
        const contact = contacts.get(userId);
        return contact === undefined ? [] : [{ userId, contact }];
      }),
    };
  }

  private async contacts(
    trx: Transaction<DB>,
    userIds: readonly string[],
  ): Promise<Map<string, UserContact>> {
    if (userIds.length === 0) return new Map();
    const rows = await trx
      .selectFrom('identity.users')
      .select(['id', 'email', 'displayName'])
      .where('id', 'in', [...userIds])
      .execute();
    return new Map(rows.map((r) => [r.id, { email: r.email, displayName: r.displayName }]));
  }

  private async afterCommit(job: LeasedFanoutJob, result: BatchResult): Promise<void> {
    for (const { userId, notificationId } of result.created) {
      try {
        await this.deliverer.push(userId, 'STUDENT', { id: notificationId, kind: 'ANNOUNCEMENT' });
      } catch (error) {
        this.logger.warn({ err: error, jobId: job.jobId }, 'Announcement push failed; continuing');
        break; // Redis is down: skip the remaining hints of this batch (clients refetch anyway)
      }
    }
    if (result.content === null) return;
    let failed = 0;
    for (const { userId, contact } of result.mails) {
      try {
        await this.deliverer.sendMail(
          contact,
          userId,
          'STUDENT',
          result.content,
          `${job.sourceEventId}.announcement.${userId}`,
        );
      } catch (error) {
        failed += 1;
        if (failed === 1) {
          this.logger.warn({ err: error, jobId: job.jobId }, 'Announcement e-mail failed');
        }
      }
    }
    if (failed > 0) {
      this.logger.warn(
        { jobId: job.jobId, failed, total: result.mails.length },
        'Some announcement e-mails were not sent (not retried)',
      );
    }
  }
}
