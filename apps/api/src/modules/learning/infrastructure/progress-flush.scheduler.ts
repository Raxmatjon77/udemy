import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { LearningSettings } from '../application/learning-settings';
import { type FlushReport, ProgressFlushJob } from '../application/progress-flush.job';

export const PROGRESS_FLUSH_INTERVAL_NAME = 'learning.progress-flush';

/**
 * Runs `ProgressFlushJob.drain` every `LEARNING_PROGRESS_FLUSH_INTERVAL_MS` (15 s) when
 * `LEARNING_JOBS_ENABLED` (design D2; registered dynamically because the interval comes from
 * the env). A tick never overlaps the previous one in this process; across replicas the
 * advisory lock `0x75646d79_06` serialises the batches. Errors are logged, never thrown into
 * the timer.
 *
 * Shutdown (SIGTERM, `app.enableShutdownHooks()`): `beforeApplicationShutdown` runs before any
 * `onApplicationShutdown`, i.e. while Redis and the pg pool are still open. It stops the
 * timer, waits for a running tick, then drains once more so the last ≤ 15 s of heartbeats this
 * replica buffered reach Postgres before the pod goes away. Best effort: the buffer is shared
 * and persistent (Redis AOF), so whatever is left is flushed by another replica or the next
 * start.
 */
@Injectable()
export class ProgressFlushScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ProgressFlushScheduler.name);
  private running: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly job: ProgressFlushJob,
    private readonly settings: LearningSettings,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.settings.jobsEnabled) {
      this.logger.log('ProgressFlushJob disabled (LEARNING_JOBS_ENABLED=false)');
      return;
    }
    const timer = setInterval(() => this.tick(), this.settings.flushIntervalMs);
    timer.unref();
    this.registry.addInterval(PROGRESS_FLUSH_INTERVAL_NAME, timer);
    this.started = true;
    this.logger.log(`ProgressFlushJob every ${this.settings.flushIntervalMs} ms`);
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.registry.doesExist('interval', PROGRESS_FLUSH_INTERVAL_NAME)) {
      this.registry.deleteInterval(PROGRESS_FLUSH_INTERVAL_NAME);
    }
    if (this.running !== null) await this.running;
    try {
      const report = await this.job.drain();
      this.logger.log(`final progress flush${signal ? ` on ${signal}` : ''}: ${summary(report)}`);
    } catch (error) {
      this.logger.warn({ err: error }, 'final progress flush failed; another replica drains it');
    }
  }

  /** One tick (exposed for tests): skipped while the previous one runs. */
  tick(): Promise<void> {
    if (this.running !== null) return this.running;
    this.running = this.job
      .drain()
      .then((report) => {
        if (report.claimed + report.recovered > 0) this.logger.debug(summary(report));
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'ProgressFlushJob failed');
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}

function summary(report: FlushReport): string {
  return report.locked
    ? `claimed ${report.claimed}, written ${report.written}, activities ${report.activities}, ` +
        `dropped ${report.dropped}, recovered ${report.recovered}`
    : 'skipped (another replica holds the lock)';
}
