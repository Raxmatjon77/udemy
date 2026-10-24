import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { leaseFanoutJob, reapExpiredFanoutLeases } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { WorkerConfigService } from '../../shared/config';
import { type FanoutJobOutcome, FanoutRunner } from './fanout-runner';

const INTERVAL_NAME = 'notification-fanout';
/** Jobs started per tick; the next tick continues (keeps one tick bounded). */
const MAX_JOBS_PER_TICK = 10;

export interface FanoutTickResult {
  readonly reaped: number;
  readonly jobs: Readonly<Record<FanoutJobOutcome, number>>;
}

/**
 * `FanoutJob` (design D18, P5-D11): every NOTIFICATION_FANOUT_INTERVAL_MS, when
 * NOTIFICATION_FANOUT_ENABLED,
 *
 * 1. the reaper requeues RUNNING jobs whose lease expired (backoff `2^attempts` minutes, FAILED
 *    after max_attempts; `SKIP LOCKED`, so a job whose batch is running is left alone);
 * 2. leases due QUEUED jobs one at a time (`FOR UPDATE SKIP LOCKED`, so replicas share the queue
 *    without a global advisory lock) and runs each with `FanoutRunner`, batch by batch.
 *
 * Ticks never overlap within a replica; shutdown waits for the batch in progress (a job left
 * RUNNING is requeued by the reaper once its 2 min lease expires and resumes from its cursor).
 */
@Injectable()
export class FanoutJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(FanoutJob.name);
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(
    -128,
  );
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly runner: FanoutRunner,
    private readonly config: WorkerConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('NOTIFICATION_FANOUT_ENABLED')) {
      this.logger.log('Announcement fan-out disabled (NOTIFICATION_FANOUT_ENABLED=false)');
      return;
    }
    // Registered intervals are cleared by @nestjs/schedule on application shutdown.
    this.scheduler.addInterval(
      INTERVAL_NAME,
      setInterval(() => this.trigger(), this.config.get('NOTIFICATION_FANOUT_INTERVAL_MS')),
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  private trigger(): void {
    if (this.stopping || this.running !== undefined) return;
    this.running = this.tick()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Fan-out tick failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One tick (reaper + up to MAX_JOBS_PER_TICK jobs). Public for tests and manual runs. */
  async tick(): Promise<FanoutTickResult> {
    const jobs: Record<FanoutJobOutcome, number> = {
      DONE: 0,
      LEASE_LOST: 0,
      FAILED: 0,
      STOPPED: 0,
    };
    const reaped = await reapExpiredFanoutLeases(this.db);
    for (const r of reaped) {
      this.logger.warn(
        { jobId: r.jobId, status: r.status, attempts: r.attempts },
        'Fan-out lease expired',
      );
    }
    for (let i = 0; i < MAX_JOBS_PER_TICK && !this.stopping; i++) {
      const job = await leaseFanoutJob(this.db, { workerId: this.workerId });
      if (job === null) break;
      const outcome = await this.runner.run(job, () => this.stopping);
      jobs[outcome] += 1;
    }
    return { reaped: reaped.length, jobs };
  }
}
