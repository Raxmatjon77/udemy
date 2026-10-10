import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { type DB, sql, type Transaction, withTransaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { WorkerConfigService } from '../shared/config';
import { ADVISORY_LOCK_KEYS } from './advisory-lock-keys';
import type { LockedResult } from './media-cleanup.steps';
import {
  dbOutboxRetentionSql,
  type OutboxRetentionContext,
  type OutboxRetentionOptions,
  type OutboxRetentionRunResult,
  type OutboxRetentionSql,
  runOutboxRetention,
} from './outbox-retention.steps';

/** Advisory-lock key of the outbox retention (`udmy` + 0x10; all keys: advisory-lock-keys.ts). */
export const OUTBOX_RETENTION_LOCK_KEY = ADVISORY_LOCK_KEYS.outboxRetention;

const INTERVAL_NAME = 'outbox-retention';
const FIRST_RUN_NAME = 'outbox-retention.first-run';

/**
 * Scheduled retention of `outbox.events` and `outbox.processed_events`, every
 * OUTBOX_RETENTION_INTERVAL_MS (first run after OUTBOX_RETENTION_INITIAL_DELAY_MS). The safety
 * argument for both tables is in outbox-retention.steps.ts.
 *
 * Same scheduling and locking style as IdentityCleanupJob: every batch is its own transaction
 * that first takes `pg_try_advisory_xact_lock(OUTBOX_RETENTION_LOCK_KEY)`; when another replica
 * holds it, this run stops. Batches loop until one is not full, bounded by
 * OUTBOX_RETENTION_MAX_BATCHES_PER_RUN per table. Runs never overlap within a replica, and
 * shutdown waits for a run in progress.
 */
@Injectable()
export class OutboxRetentionJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxRetentionJob.name);
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly config: WorkerConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('OUTBOX_RETENTION_ENABLED')) {
      this.logger.log('Outbox retention disabled (OUTBOX_RETENTION_ENABLED=false)');
      return;
    }
    const intervalMs = this.config.get('OUTBOX_RETENTION_INTERVAL_MS');
    // Registered timers are cleared by @nestjs/schedule on application shutdown.
    const first = setTimeout(() => {
      this.scheduler.deleteTimeout(FIRST_RUN_NAME);
      this.trigger();
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => this.trigger(), intervalMs),
      );
    }, this.config.get('OUTBOX_RETENTION_INITIAL_DELAY_MS'));
    this.scheduler.addTimeout(FIRST_RUN_NAME, first);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  /** The options of a run, from the validated env. */
  options(): OutboxRetentionOptions {
    return {
      slotName: this.config.get('OUTBOX_REPLICATION_SLOT'),
      eventsRetentionHours: this.config.get('OUTBOX_EVENTS_RETENTION_HOURS'),
      processedRetentionDays: this.config.get('PROCESSED_EVENTS_RETENTION_DAYS'),
      batchSize: this.config.get('OUTBOX_RETENTION_BATCH_SIZE'),
    };
  }

  /** Starts a run unless one is still in progress in this replica. */
  private trigger(): void {
    if (this.stopping) return;
    if (this.running !== undefined) {
      this.logger.warn('Previous outbox retention still running; skipping this tick');
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Outbox retention failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One complete run (both tables). Public for tests and manual runs. */
  async runOnce(
    options: OutboxRetentionOptions = this.options(),
    retentionSql: OutboxRetentionSql = dbOutboxRetentionSql,
  ): Promise<OutboxRetentionRunResult> {
    const startedAt = performance.now();
    const result = await runOutboxRetention(this.context(retentionSql), options);
    const summary = {
      ...result,
      retentionHours: options.eventsRetentionHours,
      processedRetentionDays: options.processedRetentionDays,
      durationMs: Math.round(performance.now() - startedAt),
    };
    if (result.status === 'locked') {
      this.logger.log(summary, 'Outbox retention is running in another replica; stopping');
    } else {
      this.logger.log(summary, 'Outbox retention completed');
    }
    return result;
  }

  private context(retentionSql: OutboxRetentionSql): OutboxRetentionContext {
    return {
      sql: retentionSql,
      runLocked: <T>(fn: (trx: Transaction<DB>) => Promise<T>) => this.runLocked(fn),
      maxBatches: this.config.get('OUTBOX_RETENTION_MAX_BATCHES_PER_RUN'),
      shouldStop: () => this.stopping,
      log: { warn: (context, message) => this.logger.warn(context, message) },
    };
  }

  private async runLocked<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<LockedResult<T>> {
    return withTransaction(this.db, async (trx): Promise<LockedResult<T>> => {
      const { rows } = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(${OUTBOX_RETENTION_LOCK_KEY}::bigint) AS locked`.execute(
        trx,
      );
      if (rows[0]?.locked !== true) return { acquired: false };
      return { acquired: true, value: await fn(trx) };
    });
  }
}
