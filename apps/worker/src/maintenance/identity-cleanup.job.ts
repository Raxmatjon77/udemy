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
import { type CleanupStep, identityCleanupSteps } from './identity-cleanup.steps';

/**
 * Advisory-lock key of the identity cleanup (`udmy` + 1 in hex; all keys: advisory-lock-keys.ts).
 */
export const IDENTITY_CLEANUP_LOCK_KEY = ADVISORY_LOCK_KEYS.identityCleanup;

export type CleanupRunResult =
  | { readonly status: 'completed'; readonly deleted: Readonly<Record<string, number>> }
  | { readonly status: 'locked'; readonly deleted: Readonly<Record<string, number>> };

const INTERVAL_NAME = 'identity-cleanup';
const FIRST_RUN_NAME = 'identity-cleanup.first-run';

/**
 * Scheduled retention cleanup of the identity schema (schema doc §8), every
 * IDENTITY_CLEANUP_INTERVAL_MS (first run after IDENTITY_CLEANUP_INITIAL_DELAY_MS).
 *
 * Every batch is its own transaction that first takes
 * `pg_try_advisory_xact_lock(IDENTITY_CLEANUP_LOCK_KEY)`: a session-level lock would not
 * survive the pool handing out another connection, the xact lock is released at each commit.
 * When another replica holds it, this run stops (that replica is doing the work). Statements
 * loop batch by batch until a batch is not full, bounded by IDENTITY_CLEANUP_MAX_BATCHES_PER_RUN.
 * Runs never overlap within a replica, and shutdown waits for a run in progress.
 */
@Injectable()
export class IdentityCleanupJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(IdentityCleanupJob.name);
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly config: WorkerConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('IDENTITY_CLEANUP_ENABLED')) {
      this.logger.log('Identity cleanup disabled (IDENTITY_CLEANUP_ENABLED=false)');
      return;
    }
    const intervalMs = this.config.get('IDENTITY_CLEANUP_INTERVAL_MS');
    // Registered timers are cleared by @nestjs/schedule on application shutdown.
    const first = setTimeout(() => {
      this.scheduler.deleteTimeout(FIRST_RUN_NAME);
      this.trigger();
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => this.trigger(), intervalMs),
      );
    }, this.config.get('IDENTITY_CLEANUP_INITIAL_DELAY_MS'));
    this.scheduler.addTimeout(FIRST_RUN_NAME, first);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  /** Starts a run unless one is still in progress in this replica. */
  private trigger(): void {
    if (this.stopping) return;
    if (this.running !== undefined) {
      this.logger.warn('Previous identity cleanup still running; skipping this tick');
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Identity cleanup failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One complete cleanup run (all statements). Public for tests and manual runs. */
  async runOnce(
    steps: readonly CleanupStep[] = identityCleanupSteps({
      graceDays: this.config.get('IDENTITY_CLEANUP_GRACE_DAYS'),
      tokenBatchSize: this.config.get('IDENTITY_CLEANUP_TOKEN_BATCH_SIZE'),
      sessionBatchSize: this.config.get('IDENTITY_CLEANUP_SESSION_BATCH_SIZE'),
      securityEventBatchSize: this.config.get('IDENTITY_CLEANUP_SECURITY_EVENT_BATCH_SIZE'),
    }),
  ): Promise<CleanupRunResult> {
    const maxBatches = this.config.get('IDENTITY_CLEANUP_MAX_BATCHES_PER_RUN');
    const deleted: Record<string, number> = {};
    const startedAt = performance.now();

    for (const step of steps) {
      let stepDeleted = 0;
      deleted[step.name] = stepDeleted;
      for (let batch = 0; batch < maxBatches && !this.stopping; batch += 1) {
        const result = await withTransaction(this.db, async (trx) =>
          (await this.tryLock(trx)) ? step.runBatch(trx) : null,
        );
        if (result === null) {
          this.logger.log({ deleted }, 'Identity cleanup is running in another replica; stopping');
          return { status: 'locked', deleted };
        }
        stepDeleted += result.deleted;
        deleted[step.name] = stepDeleted;
        if (!result.more) break;
      }
    }

    this.logger.log(
      { deleted, durationMs: Math.round(performance.now() - startedAt) },
      'Identity cleanup completed',
    );
    return { status: 'completed', deleted };
  }

  private async tryLock(trx: Transaction<DB>): Promise<boolean> {
    const { rows } = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_xact_lock(${IDENTITY_CLEANUP_LOCK_KEY}::bigint) AS locked`.execute(
      trx,
    );
    return rows[0]?.locked === true;
  }
}
