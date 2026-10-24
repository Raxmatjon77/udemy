import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  type DB,
  deleteExpiredNotifications,
  deleteFinishedFanoutJobs,
  NOTIFICATION_RETENTION_LOCK_KEY,
  type Transaction,
  tryAdvisoryXactLock,
  withTransaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { ADVISORY_LOCK_KEYS } from '../../maintenance/advisory-lock-keys';
import { WorkerConfigService } from '../../shared/config';

const INTERVAL_NAME = 'notification-retention';
const FIRST_RUN_NAME = 'notification-retention.first-run';
const NOTIFICATION_BATCH = 5_000;
const FANOUT_JOB_BATCH = 1_000;
/** Upper bound of batches per table and run, so one run can never loop forever. */
const MAX_BATCHES_PER_RUN = 200;

export interface NotificationRetentionResult {
  readonly status: 'completed' | 'locked';
  readonly notificationsDeleted: number;
  readonly fanoutJobsDeleted: number;
}

// The key lives in @udemy/db (schema doc §10); ADVISORY_LOCK_KEYS lists it for the whole worker.
if (NOTIFICATION_RETENTION_LOCK_KEY !== ADVISORY_LOCK_KEYS.notificationRetention) {
  throw new Error('NotificationRetentionJob: advisory lock key drifted from @udemy/db');
}

/**
 * `NotificationRetentionJob` (design §4/§5, schema doc §8.7, lock `0x75646d79_07`): daily
 * (NOTIFICATION_RETENTION_INTERVAL_MS, first run after NOTIFICATION_RETENTION_INITIAL_DELAY_MS),
 * when NOTIFICATION_RETENTION_ENABLED. Deletes inbox rows older than 180 days (5000 per batch)
 * and finished fan-out jobs older than 30 days (1000 per batch). Every batch is its own
 * transaction that first takes `pg_try_advisory_xact_lock(_07)`; when another replica holds it,
 * the run stops. Same scheduling style as OutboxRetentionJob; shutdown waits for a running batch.
 */
@Injectable()
export class NotificationRetentionJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(NotificationRetentionJob.name);
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly config: WorkerConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('NOTIFICATION_RETENTION_ENABLED')) {
      this.logger.log('Notification retention disabled (NOTIFICATION_RETENTION_ENABLED=false)');
      return;
    }
    const intervalMs = this.config.get('NOTIFICATION_RETENTION_INTERVAL_MS');
    const first = setTimeout(() => {
      this.scheduler.deleteTimeout(FIRST_RUN_NAME);
      this.trigger();
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => this.trigger(), intervalMs),
      );
    }, this.config.get('NOTIFICATION_RETENTION_INITIAL_DELAY_MS'));
    this.scheduler.addTimeout(FIRST_RUN_NAME, first);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  private trigger(): void {
    if (this.stopping) return;
    if (this.running !== undefined) {
      this.logger.warn('Previous notification retention still running; skipping this tick');
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Notification retention failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One complete run (both tables). Public for tests and manual runs. */
  async runOnce(): Promise<NotificationRetentionResult> {
    const notifications = await this.drain(
      (trx) => deleteExpiredNotifications(trx, { batchSize: NOTIFICATION_BATCH }),
      NOTIFICATION_BATCH,
    );
    if (notifications.locked) {
      return this.report({
        status: 'locked',
        notificationsDeleted: notifications.deleted,
        fanoutJobsDeleted: 0,
      });
    }
    const jobs = await this.drain(
      (trx) => deleteFinishedFanoutJobs(trx, { batchSize: FANOUT_JOB_BATCH }),
      FANOUT_JOB_BATCH,
    );
    return this.report({
      status: jobs.locked ? 'locked' : 'completed',
      notificationsDeleted: notifications.deleted,
      fanoutJobsDeleted: jobs.deleted,
    });
  }

  private report(result: NotificationRetentionResult): NotificationRetentionResult {
    this.logger.log(
      result,
      result.status === 'locked'
        ? 'Notification retention is running in another replica; stopping'
        : 'Notification retention completed',
    );
    return result;
  }

  /** Locked batches until one is not full (or the bound / shutdown). */
  private async drain(
    batch: (trx: Transaction<DB>) => Promise<number>,
    batchSize: number,
  ): Promise<{ deleted: number; locked: boolean }> {
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES_PER_RUN && !this.stopping; i++) {
      const result = await withTransaction(this.db, async (trx) => {
        if (!(await tryAdvisoryXactLock(trx, NOTIFICATION_RETENTION_LOCK_KEY))) return null;
        return batch(trx);
      });
      if (result === null) return { deleted, locked: true };
      deleted += result;
      if (result < batchSize) break;
    }
    return { deleted, locked: false };
  }
}
