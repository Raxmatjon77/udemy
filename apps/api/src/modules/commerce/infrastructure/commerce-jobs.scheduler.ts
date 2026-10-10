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

/**
 * Runs `CommerceJobs.reconcile` every `COMMERCE_RECONCILE_INTERVAL_MS` when
 * `COMMERCE_JOBS_ENABLED` (design D9; the interval comes from the env, so it is registered
 * dynamically instead of with `@Interval`). A tick never overlaps the previous one in this
 * process; across replicas the advisory lock makes one win. Errors are logged, never thrown
 * into the timer.
 */
@Injectable()
export class CommerceJobsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CommerceJobsScheduler.name);
  private running: Promise<void> | null = null;

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
    const timer = setInterval(() => this.tick(), this.settings.reconcileIntervalMs);
    timer.unref();
    this.registry.addInterval(RECONCILE_INTERVAL_NAME, timer);
    this.logger.log(`CommerceJobs.reconcile every ${this.settings.reconcileIntervalMs} ms`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.registry.doesExist('interval', RECONCILE_INTERVAL_NAME)) {
      this.registry.deleteInterval(RECONCILE_INTERVAL_NAME);
    }
    await this.running;
  }

  private tick(): void {
    if (this.running !== null) return;
    this.running = this.jobs
      .reconcile()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'CommerceJobs.reconcile failed');
      })
      .finally(() => {
        this.running = null;
      });
  }
}
