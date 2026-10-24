import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  abandonStaleQuizAttempts,
  type DB,
  findCertificatesPendingPdf,
  LEARNING_MAINTENANCE_LOCK_KEY,
  type Transaction,
  tryAdvisoryXactLock,
  withTransaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { ADVISORY_LOCK_KEYS } from '../../maintenance/advisory-lock-keys';
import { WorkerConfigService } from '../../shared/config';
import { CertificatePdfPublisher } from '../certificates/certificate-pdf.publisher';

const INTERVAL_NAME = 'learning-maintenance';
const FIRST_RUN_NAME = 'learning-maintenance.first-run';
const ATTEMPT_BATCH = 1_000;
const PDF_BATCH = 100;
/** Upper bound of abandon batches per run. */
const MAX_BATCHES_PER_RUN = 100;
/** A certificate without a PDF this long after issue is re-rendered (design §5). */
const PDF_GRACE_MINUTES = 10;

export interface LearningMaintenanceResult {
  readonly status: 'completed' | 'locked';
  readonly attemptsAbandoned: number;
  readonly pdfsRendered: number;
  readonly pdfFailures: number;
}

if (LEARNING_MAINTENANCE_LOCK_KEY !== ADVISORY_LOCK_KEYS.learningMaintenance) {
  throw new Error('LearningMaintenanceJob: advisory lock key drifted from @udemy/db');
}

/**
 * `LearningMaintenanceJob` (design §4/§5, schema doc §8.7, lock `0x75646d79_08`): hourly
 * (LEARNING_MAINTENANCE_INTERVAL_MS, first run after LEARNING_MAINTENANCE_INITIAL_DELAY_MS), when
 * LEARNING_MAINTENANCE_ENABLED.
 *
 * 1. Abandons IN_PROGRESS quiz attempts older than LEARNING_QUIZ_ATTEMPT_TTL_H (24 h), 1000 per
 *    batch (`FOR UPDATE SKIP LOCKED`: a SUBMIT holding the row wins, R3).
 * 2. Re-renders certificates whose PDF is still missing 10 minutes after issue (the issuer's
 *    after-commit render failed): the ids are read under the lock, the renders (S3 PUT) run
 *    outside any transaction.
 *
 * Every batch transaction first takes `pg_try_advisory_xact_lock(_08)`; when another replica
 * holds it, the run stops. Runs never overlap within a replica; shutdown waits for a run.
 */
@Injectable()
export class LearningMaintenanceJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(LearningMaintenanceJob.name);
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly pdf: CertificatePdfPublisher,
    private readonly config: WorkerConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('LEARNING_MAINTENANCE_ENABLED')) {
      this.logger.log('Learning maintenance disabled (LEARNING_MAINTENANCE_ENABLED=false)');
      return;
    }
    const intervalMs = this.config.get('LEARNING_MAINTENANCE_INTERVAL_MS');
    const first = setTimeout(() => {
      this.scheduler.deleteTimeout(FIRST_RUN_NAME);
      this.trigger();
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => this.trigger(), intervalMs),
      );
    }, this.config.get('LEARNING_MAINTENANCE_INITIAL_DELAY_MS'));
    this.scheduler.addTimeout(FIRST_RUN_NAME, first);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  private trigger(): void {
    if (this.stopping) return;
    if (this.running !== undefined) {
      this.logger.warn('Previous learning maintenance still running; skipping this tick');
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Learning maintenance failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One complete run. Public for tests and manual runs. */
  async runOnce(): Promise<LearningMaintenanceResult> {
    const ttlHours = this.config.get('LEARNING_QUIZ_ATTEMPT_TTL_H');
    let attemptsAbandoned = 0;
    for (let i = 0; i < MAX_BATCHES_PER_RUN && !this.stopping; i++) {
      const ids = await this.locked((trx) =>
        abandonStaleQuizAttempts(trx, { ttlHours, batchSize: ATTEMPT_BATCH }),
      );
      if (ids === null)
        return this.report({
          status: 'locked',
          attemptsAbandoned,
          pdfsRendered: 0,
          pdfFailures: 0,
        });
      attemptsAbandoned += ids.length;
      if (ids.length < ATTEMPT_BATCH) break;
    }

    const pending = await this.locked((trx) =>
      findCertificatesPendingPdf(trx, { olderThanMinutes: PDF_GRACE_MINUTES, limit: PDF_BATCH }),
    );
    if (pending === null)
      return this.report({ status: 'locked', attemptsAbandoned, pdfsRendered: 0, pdfFailures: 0 });
    let pdfsRendered = 0;
    let pdfFailures = 0;
    for (const certificateId of pending) {
      if (this.stopping) break;
      try {
        if ((await this.pdf.publish(certificateId)) === 'RENDERED') pdfsRendered += 1;
      } catch (error) {
        pdfFailures += 1;
        this.logger.warn({ err: error, certificateId }, 'Certificate PDF re-render failed');
      }
    }
    return this.report({ status: 'completed', attemptsAbandoned, pdfsRendered, pdfFailures });
  }

  private report(result: LearningMaintenanceResult): LearningMaintenanceResult {
    this.logger.log(
      result,
      result.status === 'locked'
        ? 'Learning maintenance is running in another replica; stopping'
        : 'Learning maintenance completed',
    );
    return result;
  }

  /** `fn` in a transaction holding `_08`; null when another replica holds it. */
  private async locked<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T | null> {
    return withTransaction(this.db, async (trx) => {
      if (!(await tryAdvisoryXactLock(trx, LEARNING_MAINTENANCE_LOCK_KEY))) return null;
      return fn(trx);
    });
  }
}
