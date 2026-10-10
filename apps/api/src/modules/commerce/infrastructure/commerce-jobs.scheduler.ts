import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CommerceJobs } from '../application/commerce-jobs';
import { CommerceSettings } from '../application/commerce-settings';

export const RECONCILE_INTERVAL_NAME = 'commerce.reconcile';
export const REFUND_DISPATCH_INTERVAL_NAME = 'commerce.dispatch-refunds';

type Job = 'reconcile' | 'dispatchRefunds';

/**
 * Runs `CommerceJobs.reconcile` every `COMMERCE_RECONCILE_INTERVAL_MS` and
 * `CommerceJobs.dispatchRefunds` every `COMMERCE_REFUND_DISPATCH_INTERVAL_MS` when
 * `COMMERCE_JOBS_ENABLED` (design D9; the intervals come from the env, so they are registered
 * dynamically instead of with `@Interval`). A job's tick never overlaps its previous one in
 * this process; across replicas the advisory locks (`_04`, `_03`) make one win. Errors are
 * logged, never thrown into the timer.
 */
@Injectable()
export class CommerceJobsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CommerceJobsScheduler.name);
  private readonly running = new Map<Job, Promise<void>>();

  constructor(
    private readonly jobs: CommerceJobs,
    private readonly settings: CommerceSettings,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.settings.jobsEnabled) {
      this.logger.log('CommerceJobs disabled (COMMERCE_JOBS_ENABLED=false)');
      return;
    }
    this.every(RECONCILE_INTERVAL_NAME, this.settings.reconcileIntervalMs, 'reconcile');
    this.every(
      REFUND_DISPATCH_INTERVAL_NAME,
      this.settings.refundDispatchIntervalMs,
      'dispatchRefunds',
    );
  }

  async onApplicationShutdown(): Promise<void> {
    for (const name of [RECONCILE_INTERVAL_NAME, REFUND_DISPATCH_INTERVAL_NAME]) {
      if (this.registry.doesExist('interval', name)) this.registry.deleteInterval(name);
    }
    await Promise.all([...this.running.values()]);
  }

  private every(name: string, intervalMs: number, job: Job): void {
    const timer = setInterval(() => this.tick(job), intervalMs);
    timer.unref();
    this.registry.addInterval(name, timer);
    this.logger.log(`CommerceJobs.${job} every ${intervalMs} ms`);
  }

  private tick(job: Job): void {
    if (this.running.has(job)) return;
    const run = job === 'reconcile' ? this.jobs.reconcile() : this.jobs.dispatchRefunds();
    this.running.set(
      job,
      run
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logger.error({ err: error }, `CommerceJobs.${job} failed`);
        })
        .finally(() => {
          this.running.delete(job);
        }),
    );
  }
}
