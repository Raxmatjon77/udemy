import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { type DB, sql, type Transaction, withTransaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { ObjectStorage } from '@udemy/storage';
import { WorkerConfigService } from '../shared/config';
import { ADVISORY_LOCK_KEYS } from './advisory-lock-keys';
import {
  type CleanupStorage,
  dbMediaCleanupSql,
  type LockedResult,
  type MediaCleanupContext,
  type MediaCleanupOptions,
  type MediaCleanupStep,
  mediaCleanupSteps,
} from './media-cleanup.steps';

/** Advisory-lock key of the media cleanup (`udmy` + 2 in hex; design §5; all keys: advisory-lock-keys.ts). */
export const MEDIA_CLEANUP_LOCK_KEY = ADVISORY_LOCK_KEYS.mediaCleanup;

export interface MediaCleanupRunResult {
  readonly status: 'completed' | 'locked';
  /** `step.counter` -> rows / objects handled in this run. */
  readonly counts: Readonly<Record<string, number>>;
  /** S3 calls that failed in this run (each is retried by a later run). */
  readonly s3Failures: number;
}

const INTERVAL_NAME = 'media-cleanup';
const FIRST_RUN_NAME = 'media-cleanup.first-run';

/**
 * Scheduled media janitor (design §5 MediaCleanupJob, steps A-D; schema doc §8.2), every
 * MEDIA_CLEANUP_INTERVAL_MS (first run after MEDIA_CLEANUP_INITIAL_DELAY_MS). Same scheduling
 * and locking style as IdentityCleanupJob:
 *
 * - Every DB batch is its own transaction that first takes
 *   `pg_try_advisory_xact_lock(MEDIA_CLEANUP_LOCK_KEY)`; when another replica holds it, this run
 *   stops (that replica is doing the work).
 * - S3 calls happen between those transactions, never inside one (no transaction is held open
 *   across network I/O).
 * - Runs never overlap within a replica, and shutdown waits for a run in progress before the
 *   S3 clients are destroyed.
 */
@Injectable()
export class MediaCleanupJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(MediaCleanupJob.name);
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly config: WorkerConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('MEDIA_CLEANUP_ENABLED')) {
      this.logger.log('Media cleanup disabled (MEDIA_CLEANUP_ENABLED=false)');
      return;
    }
    const intervalMs = this.config.get('MEDIA_CLEANUP_INTERVAL_MS');
    // Registered timers are cleared by @nestjs/schedule on application shutdown.
    const first = setTimeout(() => {
      this.scheduler.deleteTimeout(FIRST_RUN_NAME);
      this.trigger();
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => this.trigger(), intervalMs),
      );
    }, this.config.get('MEDIA_CLEANUP_INITIAL_DELAY_MS'));
    this.scheduler.addTimeout(FIRST_RUN_NAME, first);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  /** The options of a run, from the validated env. */
  options(): MediaCleanupOptions {
    return {
      batchSize: this.config.get('MEDIA_CLEANUP_BATCH_SIZE'),
      uploadTtlHours: this.config.get('MEDIA_UPLOAD_TTL_HOURS'),
      neverUsedGraceHours: this.config.get('MEDIA_UNATTACHED_GRACE_HOURS'),
      releasedGraceDays: this.config.get('MEDIA_UNUSED_GRACE_DAYS'),
      sourceRetentionDays: this.config.get('MEDIA_SOURCE_RETENTION_DAYS'),
    };
  }

  /** Starts a run unless one is still in progress in this replica. */
  private trigger(): void {
    if (this.stopping) return;
    if (this.running !== undefined) {
      this.logger.warn('Previous media cleanup still running; skipping this tick');
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Media cleanup failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One complete cleanup run (all steps). Public for tests and manual runs. */
  async runOnce(
    steps: readonly MediaCleanupStep[] = mediaCleanupSteps(this.options()),
  ): Promise<MediaCleanupRunResult> {
    const counts: Record<string, number> = {};
    let s3Failures = 0;
    const startedAt = performance.now();
    const ctx = this.context();
    for (const step of steps) {
      if (this.stopping) break;
      const result = await step.run(ctx);
      for (const [name, n] of Object.entries(result.counts)) counts[`${step.name}.${name}`] = n;
      s3Failures += result.s3Failures;
      if (result.status === 'locked') {
        this.logger.log(
          { counts, s3Failures },
          'Media cleanup is running in another replica; stopping',
        );
        return { status: 'locked', counts, s3Failures };
      }
    }
    const summary = {
      counts,
      s3Failures,
      durationMs: Math.round(performance.now() - startedAt),
    };
    if (s3Failures > 0) {
      this.logger.warn(summary, 'Media cleanup completed with S3 failures (retried next run)');
    } else {
      this.logger.log(summary, 'Media cleanup completed');
    }
    return { status: 'completed', counts, s3Failures };
  }

  private context(): MediaCleanupContext {
    const storage: CleanupStorage = this.storage;
    return {
      sql: dbMediaCleanupSql,
      storage,
      runLocked: <T>(fn: (trx: Transaction<DB>) => Promise<T>) => this.runLocked(fn),
      maxBatches: this.config.get('MEDIA_CLEANUP_MAX_BATCHES_PER_RUN'),
      shouldStop: () => this.stopping,
      log: {
        warn: (context, message) => this.logger.warn(context, message),
        error: (context, message) => this.logger.error(context, message),
      },
      now: () => new Date(),
    };
  }

  private async runLocked<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<LockedResult<T>> {
    return withTransaction(this.db, async (trx): Promise<LockedResult<T>> => {
      const { rows } = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(${MEDIA_CLEANUP_LOCK_KEY}::bigint) AS locked`.execute(
        trx,
      );
      if (rows[0]?.locked !== true) return { acquired: false };
      return { acquired: true, value: await fn(trx) };
    });
  }
}
